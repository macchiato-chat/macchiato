/**
 * #72 附件入站：下載 server 下發的 presigned GET url 到本地文件,路徑注入 prompt 供 Claude Code
 * 的 Read 工具讀取(圖片走視覺)。
 * SSRF / 本地文件防護(移植 Hermes 連接器 2026-07-05 的 #12 修復):url 直接喂 fetch 會被
 * file:// 讀本機密鑰、或指向內網/雲元數據做 SSRF(萬一 server 被攻破/明文 MITM)。只允許 https
 * (或 http+localhost 的 dev 服務);https 目標解析後不得落私網/環回/link-local/保留段;下載 100MB 封頂。
 */
import { lookup } from "node:dns/promises";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export const DOWNLOAD_MAX = 100 * 1024 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function attachDir(): string {
  return process.env.MACCHIATO_CC_ATTACH_DIR || join(homedir(), ".macchiato/cc-attachments");
}

/** IPv4/IPv6 私網/環回/link-local/保留段判定(無依賴手寫,覆蓋 SSRF 常用目標)。 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(".")) {
    const p = ip.split(".").map(Number);
    if (p.length !== 4 || p.some((x) => Number.isNaN(x))) return true; // 解析不了按危險處理
    const [a, b] = p as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / 雲元數據
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast + 保留
    );
  }
  const low = ip.toLowerCase();
  return (
    low === "::1" ||
    low === "::" ||
    low.startsWith("fc") ||
    low.startsWith("fd") || // ULA fc00::/7
    low.startsWith("fe8") ||
    low.startsWith("fe9") ||
    low.startsWith("fea") ||
    low.startsWith("feb") || // link-local fe80::/10
    low.startsWith("ff") || // multicast
    low.startsWith("::ffff:") // v4-mapped:遞歸判 v4 部分
      ? low.startsWith("::ffff:")
        ? isPrivateIp(low.slice(7))
        : true
      : false
  );
}

/** 下載前校驗 url(拋錯=拒絕)。 */
export async function validateDownloadUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`無效 url`);
  }
  const host = (u.hostname || "").toLowerCase();
  if (u.protocol === "http:" && LOCAL_HOSTS.has(host)) return; // 本地 dev 服務(生產走 https)
  if (u.protocol !== "https:") throw new Error(`不允許的 scheme:${u.protocol}(只允許 https)`);
  if (!host) throw new Error("url 缺主機名");
  const addrs = await lookup(host, { all: true }).catch((e) => {
    throw new Error(`解析主機失敗:${(e as Error).message}`);
  });
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`目標 IP ${address} 在私網/環回/保留範圍(防 SSRF)`);
  }
}

function sanitizeName(name: string): string {
  const base = (name || "file").split(/[/\\]/).pop() || "file";
  return base.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file";
}

export interface AttachmentRefLike {
  id?: unknown;
  name?: unknown;
  mime?: unknown;
  url?: unknown;
}

/** #118 原生圖片上限:Anthropic API 圖片 ~5MB(base64 後),留餘量取 3.5MB 原始字節。 */
export const IMAGE_BLOCK_MAX = 3_500_000;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * #118 原生圖片入站(#72 升級,#116 c 探針背書):API 支持的圖片類型且 ≤3.5MB → image content
 * block(視覺直達,不再繞 Read 工具);超限/非圖/讀失敗 → null(回退路徑注入,行為同舊)。
 */
export function imageBlockFor(path: string, mime: string): Record<string, unknown> | null {
  const mt = mime.toLowerCase();
  if (!IMAGE_MIMES.has(mt)) return null;
  try {
    if (statSync(path).size > IMAGE_BLOCK_MAX) return null;
    return { type: "image", source: { type: "base64", media_type: mt, data: readFileSync(path).toString("base64") } };
  } catch {
    return null;
  }
}

/** 下載附件到本地,返回落盤路徑。 */
export async function materializeAttachment(ref: AttachmentRefLike): Promise<string> {
  const url = String(ref.url ?? "");
  await validateDownloadUrl(url);
  const dir = join(attachDir(), String(ref.id ?? "att").replace(/[^\w\-]+/g, "_"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sanitizeName(String(ref.name ?? "file")));
  const res = await fetch(url, { headers: { "user-agent": "macchiato-cc-connector" }, redirect: "error" });
  if (!res.ok || !res.body) throw new Error(`下載失敗 HTTP ${res.status}`);
  let written = 0;
  const counter = new Writable({
    write(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > DOWNLOAD_MAX) return cb(new Error(`下載超過上限 ${DOWNLOAD_MAX} 字節`));
      out.write(chunk, cb);
    },
    final(cb) {
      out.end(cb);
    },
  });
  const out = createWriteStream(path);
  await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream), counter);
  return path;
}


/** #151 入站附件 TTL GC:prompt 早已消費,超時即刪(默認 6h,env 可調)。結構固定兩層
 *  attachDir/<id>/<file>;刪過期文件、清空的 id 目錄。health tick 調用(節流 10min)。 */
const ATTACH_TTL_MS = Number(process.env.MACCHIATO_CC_ATTACH_TTL_S || 6 * 3600) * 1000;
let lastGcAt = 0;
export function gcAttachments(now = Date.now()): number {
  if (now - lastGcAt < 10 * 60_000) return 0;
  lastGcAt = now;
  let removed = 0;
  let ids: string[] = [];
  try {
    ids = readdirSync(attachDir());
  } catch {
    return 0;
  }
  for (const id of ids) {
    const dir = join(attachDir(), id);
    try {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (now - statSync(p).mtimeMs > ATTACH_TTL_MS) {
          rmSync(p, { force: true });
          removed += 1;
        }
      }
      if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 單目錄失敗不擋全局 */
    }
  }
  return removed;
}
