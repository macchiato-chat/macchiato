/**
 * #72 附件入站：下載 server 下發的 presigned GET url 到本地文件,路徑注入 prompt 供 Claude Code
 * 的 Read 工具讀取(圖片走視覺)。
 * SSRF / 本地文件防護(移植 Hermes 連接器 2026-07-05 的 #12 修復):url 直接喂 fetch 會被
 * file:// 讀本機密鑰、或指向內網/雲元數據做 SSRF(萬一 server 被攻破/明文 MITM)。只允許 https；生產默認拒 loopback(#379)；dev 須 MACCHIATO_ATTACH_ALLOW_LOCALHOST=1;https 目標解析後不得落私網/環回/link-local/保留段;下載 100MB 封頂。
 *
 * #383 落盤硬化:attachment root/文件 0700/0600;O_EXCL|O_NOFOLLOW 臨時寫 + 原子 rename;
 * Content-Length 早拒;全局磁盤配額 + 並發上限;失敗 finally unlink partial;GC 用 lstat 不跟隨 symlink。
 */
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
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  isPrivateIp,
  isAllowedLocalHttp,
  validateDownloadUrl,
  pinnedLookup,
} from "../_core/attachments/ssrf";
import { attachDir as coreAttachDir } from "../_core/identity";
import { KIND } from "../identity";
export { isPrivateIp, isAllowedLocalHttp, validateDownloadUrl, pinnedLookup };

export const DOWNLOAD_MAX = 100 * 1024 * 1024;
/** 全局 attach root 總字節默認 2 GiB(env `MACCHIATO_CC_ATTACH_QUOTA_BYTES` 可調)。 */
export const ATTACH_QUOTA_DEFAULT = 2 * 1024 * 1024 * 1024;
/** 並發下載默認 3(env `MACCHIATO_CC_ATTACH_MAX_INFLIGHT` 可調)。 */
export const ATTACH_MAX_INFLIGHT_DEFAULT = 3;
/** 崩潰殘留 `.part` 超過此時長才由 GC 清(須 > 下載超時 60s)。 */
const PART_STALE_MS = 15 * 60_000;

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = constants;

/** #572 落盘根按 kind 单源于 connector-core/identity（materialize/gc 仍在各家）。 */
function attachDir(): string {
  return coreAttachDir(KIND);
}

export function attachQuotaBytes(): number {
  const n = Number(process.env.MACCHIATO_CC_ATTACH_QUOTA_BYTES ?? ATTACH_QUOTA_DEFAULT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ATTACH_QUOTA_DEFAULT;
}

export function attachMaxInflight(): number {
  const n = Number(process.env.MACCHIATO_CC_ATTACH_MAX_INFLIGHT ?? ATTACH_MAX_INFLIGHT_DEFAULT);
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

export async function materializeAttachment(ref: AttachmentRefLike): Promise<string> {
  const url = String(ref.url ?? "");
  await validateDownloadUrl(url); // 早拒:scheme / 字面私網

  const maxInf = attachMaxInflight();
  if (inflightDownloads >= maxInf) {
    throw new Error(`附件並發下載達上限 ${maxInf}`);
  }
  inflightDownloads += 1;

  const u = new URL(url);
  const isLocalHttp = u.protocol === "http:"; // validateDownloadUrl 已限 http 僅 localhost
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

    // #249 node http/https 默認**不跟隨重定向**(不同於 fetch)→ 順帶堵死 redirect-based SSRF;
    // https 連接掛 pinnedLookup 校驗實際 IP,消除 rebinding TOCTOU。localhost dev 走 http 不 pin。
    const res: IncomingMessage = await new Promise((resolve, reject) => {
      const req = mod.get(
        url,
        { headers: { "user-agent": "macchiato-cc-connector" }, ...(isLocalHttp ? {} : { lookup: pinnedLookup }) },
        (r) => {
          const code = r.statusCode ?? 0;
          if (code >= 300) {
            r.resume(); // 排空,免 socket 掛住
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
const ATTACH_TTL_MS = Number(process.env.MACCHIATO_CC_ATTACH_TTL_S || 6 * 3600) * 1000;
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
