/**
 * #146(codex):移植自 CC cc/attachments.ts(去掉原生 image block——codex exec 無圖片輸入,
 * 一律「落盤 + 路徑注入 prompt」讓 codex 用讀檔工具訪問)。
 * #72 附件入站：下載 server 下發的 presigned GET url 到本地文件,路徑注入 prompt 供 Claude Code
 * 的 Read 工具讀取(圖片走視覺)。
 * SSRF / 本地文件防護(移植 Hermes 連接器 2026-07-05 的 #12 修復):url 直接喂 fetch 會被
 * file:// 讀本機密鑰、或指向內網/雲元數據做 SSRF(萬一 server 被攻破/明文 MITM)。只允許 https；生產默認拒 loopback(#379)；dev 須 MACCHIATO_ATTACH_ALLOW_LOCALHOST=1;https 目標解析後不得落私網/環回/link-local/保留段;下載 100MB 封頂。
 *
 * #383 落盤硬化:attachment root/文件 0700/0600;O_EXCL|O_NOFOLLOW 臨時寫 + 原子 rename;
 * Content-Length 早拒;全局磁盤配額 + 並發上限;失敗 finally unlink partial;GC 用 lstat 不跟隨 symlink。
 */
import { lookup } from "node:dns/promises";
import { lookup as dnsLookupCb } from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import {
  chmodSync,
  closeSync,
  constants,
  createWriteStream,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DOWNLOAD_MAX = 100 * 1024 * 1024;
/** 全局 attach root 總字節默認 2 GiB(env `MACCHIATO_CODEX_ATTACH_QUOTA_BYTES` 可調)。 */
export const ATTACH_QUOTA_DEFAULT = 2 * 1024 * 1024 * 1024;
/** 並發下載默認 3(env `MACCHIATO_CODEX_ATTACH_MAX_INFLIGHT` 可調)。 */
export const ATTACH_MAX_INFLIGHT_DEFAULT = 3;
/** 崩潰殘留 `.part` 超過此時長才由 GC 清(須 > 下載超時 60s)。 */
const PART_STALE_MS = 15 * 60_000;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = constants;

function attachDir(): string {
  return process.env.MACCHIATO_CODEX_ATTACH_DIR || join(homedir(), ".macchiato/codex-attachments");
}

export function attachQuotaBytes(): number {
  const n = Number(process.env.MACCHIATO_CODEX_ATTACH_QUOTA_BYTES ?? ATTACH_QUOTA_DEFAULT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ATTACH_QUOTA_DEFAULT;
}

export function attachMaxInflight(): number {
  const n = Number(process.env.MACCHIATO_CODEX_ATTACH_MAX_INFLIGHT ?? ATTACH_MAX_INFLIGHT_DEFAULT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ATTACH_MAX_INFLIGHT_DEFAULT;
}

/** 進程內 in-flight 計數(單連接器實例)。測試可讀。 */
let inflightDownloads = 0;
export function attachInflightCount(): number {
  return inflightDownloads;
}
/** @internal 測試重置 / 佔位。 */
export function _resetAttachInflightForTest(): void {
  inflightDownloads = 0;
}
/** @internal 測試佔位 in-flight。 */
export function _setAttachInflightForTest(n: number): void {
  inflightDownloads = Math.max(0, Math.floor(n));
}

/** 目錄 0700(recursive mkdir + chmod,跨平台 mode 參數不可靠時 chmod 兜底)。 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows 等可能無 chmod 語義 */
  }
}

/** 統計 attach root 佔用(lstat,不跟隨 symlink;只計常規文件)。 */
export function duAttachRoot(root = attachDir()): number {
  let total = 0;
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return 0;
  }
  for (const id of ids) {
    const dir = join(root, id);
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) {
      total += st.size;
      continue;
    }
    if (!st.isDirectory()) continue;
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const fs = lstatSync(join(dir, f));
        if (fs.isFile()) total += fs.size;
      } catch {
        /* 單文件失敗不擋 */
      }
    }
  }
  return total;
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
export function isAllowedLocalHttp(u: URL): boolean {
  if (process.env.MACCHIATO_ATTACH_ALLOW_LOCALHOST !== "1") return false;
  if (u.protocol !== "http:") return false;
  // Node 部分版本 hostname 對 IPv6 帶方括號（[::1]）；WHATWG 則不帶——兩邊都接。
  const host = (u.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOCAL_HOSTS.has(host)) return false;
  // userinfo 混淆(http://evil@127.0.0.1/…)一律拒
  if (u.username || u.password) return false;
  const portRaw = process.env.MACCHIATO_ATTACH_LOCAL_PORT;
  const wantPort =
    portRaw === undefined || portRaw === ""
      ? 8080
      : Number(portRaw);
  if (!Number.isInteger(wantPort) || wantPort < 1 || wantPort > 65535) return false;
  const gotPort = u.port ? Number(u.port) : 80; // http 默認 80；dev-disk 是 8080，必須顯式帶端口
  if (gotPort !== wantPort) return false;
  // 空字串=不限 path（測試用）；未設默認 /attachments（對齊 dev-disk）
  const prefix =
    process.env.MACCHIATO_ATTACH_LOCAL_PATH_PREFIX === undefined
      ? "/attachments"
      : process.env.MACCHIATO_ATTACH_LOCAL_PATH_PREFIX;
  if (prefix) {
    const path = u.pathname || "/";
    if (path !== prefix && !path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) {
      return false;
    }
  }
  return true;
}

export async function validateDownloadUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`無效 url`);
  }
  if (isAllowedLocalHttp(u)) return; // #379 顯式 dev 才放行 http→loopback
  if (u.protocol !== "https:") {
    throw new Error(
      `不允許的 scheme:${u.protocol}(只允許 https；本地 dev-disk 需 MACCHIATO_ATTACH_ALLOW_LOCALHOST=1)`,
    );
  }
  const host = (u.hostname || "").toLowerCase();
  if (!host) throw new Error("url 缺主機名");
  if (u.username || u.password) throw new Error("url 不得含 userinfo(防混淆)");
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

/**
 * #249 pin-IP 解析:socket 連接時用它做 DNS——校驗**實際要連的那個 IP**。DNS-rebinding 換的正是
 * 這次連接解析到的 IP,當場被拒;validateDownloadUrl 的預解析只是早拒,真正把關在這裡(單次解析、
 * 直接用於 socket,無「校驗解析 ≠ 連接解析」的 TOCTOU 窗口)。
 */
export function pinnedLookup(
  hostname: string,
  options: unknown,
  cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
): void {
  dnsLookupCb(hostname, { ...(options as object), all: false }, (err, address, family) => {
    if (err) return cb(err, address as unknown as string, family as unknown as number);
    if (isPrivateIp(address)) {
      return cb(new Error(`目標 IP ${address} 在私網/保留範圍(防 SSRF DNS-rebinding)`), address, family);
    }
    cb(null, address, family);
  });
}

/** 下載附件到本地,返回落盤路徑。#383:私有權限 / 配額 / 失敗清理。 */
export async function materializeAttachment(ref: AttachmentRefLike): Promise<string> {
  const url = String(ref.url ?? "");
  await validateDownloadUrl(url); // 早拒:scheme / 字面私網

  const maxInf = attachMaxInflight();
  if (inflightDownloads >= maxInf) {
    throw new Error(`附件並發下載達上限 ${maxInf}`);
  }
  inflightDownloads += 1;

  const u = new URL(url);
  const isLocalHttp = u.protocol === "http:";
  const mod = u.protocol === "https:" ? https : http;
  const root = attachDir();
  const dir = join(root, String(ref.id ?? "att").replace(/[^\w\-]+/g, "_"));
  const finalName = sanitizeName(String(ref.name ?? "file"));
  const finalPath = join(dir, finalName);
  const tmpPath = join(dir, `.${finalName}.${randomBytes(8).toString("hex")}.part`);

  let out: ReturnType<typeof createWriteStream> | undefined;
  let fd: number | undefined;
  let published = false;

  try {
    ensurePrivateDir(root);
    ensurePrivateDir(dir);

    const used = duAttachRoot(root);
    const quota = attachQuotaBytes();
    if (used >= quota) {
      throw new Error(`附件磁盤配額已滿 ${used}/${quota} 字節`);
    }

    // #249 node http/https 默認不跟隨重定向 → 順帶堵死 redirect-based SSRF;https 掛 pinnedLookup 校驗實際 IP。
    const res: IncomingMessage = await new Promise((resolve, reject) => {
      const req = mod.get(
        url,
        { headers: { "user-agent": "macchiato-codex-connector" }, ...(isLocalHttp ? {} : { lookup: pinnedLookup }) },
        (r) => {
          const code = r.statusCode ?? 0;
          if (code >= 300) {
            r.resume();
            return reject(new Error(`下載失敗/拒重定向 HTTP ${code}`));
          }
          resolve(r);
        },
      );
      req.on("error", reject);
      req.setTimeout(60_000, () => req.destroy(new Error("下載超時")));
    });

    // Content-Length 早拒:帶頭且超 DOWNLOAD_MAX / 配額 → 不寫盤
    const clRaw = res.headers["content-length"];
    if (clRaw != null && clRaw !== "") {
      const cl = Number(clRaw);
      if (Number.isFinite(cl) && cl >= 0) {
        if (cl > DOWNLOAD_MAX) {
          res.resume();
          throw new Error(`Content-Length ${cl} 超過上限 ${DOWNLOAD_MAX}`);
        }
        if (used + cl > quota) {
          res.resume();
          throw new Error(`附件將超過磁盤配額 ${used}+${cl}/${quota}`);
        }
      }
    }

    try {
      fd = openSync(tmpPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    } catch (e) {
      res.resume();
      throw new Error(`無法創建附件臨時文件:${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    out = createWriteStream(tmpPath, { fd, autoClose: true, mode: 0o600 });
    fd = undefined; // 所有權交給 stream
    out.on("error", () => {
      /* pipeline 會把錯誤上拋;避免 destroy 競態變成 unhandled */
    });

    let written = 0;
    const counter = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (!out || out.destroyed) return cb(new Error(`下載寫入已中止`));
        written += chunk.length;
        if (written > DOWNLOAD_MAX) return cb(new Error(`下載超過上限 ${DOWNLOAD_MAX} 字節`));
        try {
          if (!out.write(chunk)) {
            out.once("drain", cb);
          } else {
            cb();
          }
        } catch (e) {
          cb(e as Error);
        }
      },
      final(cb) {
        if (!out || out.destroyed) return cb();
        out.end(cb);
      },
    });
    try {
      await pipeline(res, counter);
    } catch (e) {
      try {
        res.destroy();
      } catch {
        /* */
      }
      try {
        out.destroy();
      } catch {
        /* */
      }
      throw e;
    }

    renameSync(tmpPath, finalPath);
    published = true;
    return finalPath;
  } finally {
    inflightDownloads = Math.max(0, inflightDownloads - 1);
    if (!published) {
      if (out && !out.destroyed) {
        try {
          out.destroy();
        } catch {
          /* */
        }
      }
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          /* */
        }
      }
      try {
        unlinkSync(tmpPath);
      } catch {
        /* partial 可能尚未創建 */
      }
    }
  }
}

/** #151 入站附件 TTL GC:prompt 早已消費,超時即刪(默認 6h,env 可調)。結構固定兩層
 *  attachDir/<id>/<file>;刪過期文件、清空的 id 目錄。health tick 調用(節流 10min)。
 *  #383:lstat 不跟隨 symlink;清 symlink/未知/過期 `.part` 殘留;目錄保持 0700。 */
const ATTACH_TTL_MS = Number(process.env.MACCHIATO_CODEX_ATTACH_TTL_S || 6 * 3600) * 1000;
let lastGcAt = 0;
export function gcAttachments(now = Date.now()): number {
  if (now - lastGcAt < 10 * 60_000) return 0;
  lastGcAt = now;
  let removed = 0;
  const root = attachDir();
  try {
    chmodSync(root, 0o700);
  } catch {
    /* root 可能尚不存在 */
  }
  let ids: string[] = [];
  try {
    ids = readdirSync(root);
  } catch {
    return 0;
  }
  for (const id of ids) {
    const dir = join(root, id);
    try {
      const dst = lstatSync(dir);
      if (dst.isSymbolicLink() || !dst.isDirectory()) {
        // 不跟隨 symlink;根下非目錄雜物直接清
        rmSync(dir, { force: true, recursive: true });
        removed += 1;
        continue;
      }
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* */
      }
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          const st = lstatSync(p);
          if (st.isSymbolicLink()) {
            unlinkSync(p);
            removed += 1;
            continue;
          }
          if (!st.isFile()) {
            rmSync(p, { recursive: true, force: true });
            removed += 1;
            continue;
          }
          const isPart = f.startsWith(".") && f.endsWith(".part");
          const age = now - st.mtimeMs;
          if ((isPart && age > PART_STALE_MS) || (!isPart && age > ATTACH_TTL_MS)) {
            unlinkSync(p);
            removed += 1;
          }
        } catch {
          /* 單文件失敗不擋 */
        }
      }
      if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 單目錄失敗不擋全局 */
    }
  }
  return removed;
}
