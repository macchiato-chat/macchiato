/**
 * #146(codex):移植自 CC cc/attachments.ts(去掉原生 image block——codex exec 無圖片輸入,
 * 一律「落盤 + 路徑注入 prompt」讓 codex 用讀檔工具訪問)。
 * #72 附件入站：下載 server 下發的 presigned GET url 到本地文件,路徑注入 prompt 供 Claude Code
 * 的 Read 工具讀取(圖片走視覺)。
 * SSRF / 本地文件防護(移植 Hermes 連接器 2026-07-05 的 #12 修復):url 直接喂 fetch 會被
 * file:// 讀本機密鑰、或指向內網/雲元數據做 SSRF(萬一 server 被攻破/明文 MITM)。只允許 https
 * (或 http+localhost 的 dev 服務);https 目標解析後不得落私網/環回/link-local/保留段;下載 100MB 封頂。
 */
import { lookup } from "node:dns/promises";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export const DOWNLOAD_MAX = 100 * 1024 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function attachDir(): string {
  return process.env.MACCHIATO_CODEX_ATTACH_DIR || join(homedir(), ".macchiato/codex-attachments");
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

/** 下載附件到本地,返回落盤路徑。 */
export async function materializeAttachment(ref: AttachmentRefLike): Promise<string> {
  const url = String(ref.url ?? "");
  await validateDownloadUrl(url);
  const dir = join(attachDir(), String(ref.id ?? "att").replace(/[^\w\-]+/g, "_"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, sanitizeName(String(ref.name ?? "file")));
  const res = await fetch(url, { headers: { "user-agent": "macchiato-codex-connector" }, redirect: "error" });
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
