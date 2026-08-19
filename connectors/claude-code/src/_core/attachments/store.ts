/**
 * #72 / #383 / #151 附件落盘 store（#631：CC↔Codex 同构层抽进 connector-core）。
 *
 * 下载 server 下发的 presigned GET url 到本地文件，路径注入 prompt 供 agent 的读档工具访问。
 * OpenClaw 走内存 base64，**不**用本模块。
 *
 * SSRF / 本地文件防护(#12 / #249 / #379)：只允许 https；生产默认拒 loopback；dev 须
 * MACCHIATO_ATTACH_ALLOW_LOCALHOST=1；https 目标解析后不得落私网/环回/link-local/保留段；
 * 下载 100MB 封顶。落盘硬化：root/文件 0700/0600；O_EXCL|O_NOFOLLOW 临时写 + 原子 rename；
 * **先占住 .part 再走网络**（#1006：GC 会拆空目录，mkdir→GET 之间被 rmdir 就 ENOENT）；
 * Content-Length 早拒；全局磁盘配额 + 并发上限；失败 finally unlink partial；GC 用 lstat
 * 不跟随 symlink。
 *
 * 按 `AttachKind` 参数化：落盘根 / 配额·并发·TTL 的 env 名 / User-Agent（见 identity）。
 * CC 独有 `imageBlockFor` 留在 CC。
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
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AttachKind,
  attachDir,
  attachMaxInflightEnvName,
  attachQuotaEnvName,
  attachTtlEnvName,
  attachUserAgent,
} from "../identity";
import { pinnedLookup, validateDownloadUrl } from "./ssrf";

export const DOWNLOAD_MAX = 100 * 1024 * 1024;
/** 全局 attach root 总字节默认 2 GiB（env 可调，见 attachQuotaEnvName）。 */
export const ATTACH_QUOTA_DEFAULT = 2 * 1024 * 1024 * 1024;
/** 并发下载默认 3（env 可调，见 attachMaxInflightEnvName）。 */
export const ATTACH_MAX_INFLIGHT_DEFAULT = 3;
/** 崩溃残留 `.part` 超过此时长才由 GC 清（须 > 下载超时 60s）。 */
export const PART_STALE_MS = 15 * 60_000;
/** 默认 TTL 秒数（env 未设时；与历史 `|| 6 * 3600` 一致）。 */
export const ATTACH_TTL_DEFAULT_S = 6 * 3600;
/** GC 节流窗。 */
export const GC_THROTTLE_MS = 10 * 60_000;

const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = constants;

export function attachQuotaBytes(kind: AttachKind): number {
  const n = Number(process.env[attachQuotaEnvName(kind)] ?? ATTACH_QUOTA_DEFAULT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ATTACH_QUOTA_DEFAULT;
}

export function attachMaxInflight(kind: AttachKind): number {
  const n = Number(process.env[attachMaxInflightEnvName(kind)] ?? ATTACH_MAX_INFLIGHT_DEFAULT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : ATTACH_MAX_INFLIGHT_DEFAULT;
}

/** 读 TTL：与历史 `Number(env || 6*3600) * 1000` 同形（NaN 时 age 比较恒假 = 不删正文件）。 */
export function attachTtlMs(kind: AttachKind): number {
  return Number(process.env[attachTtlEnvName(kind)] || ATTACH_TTL_DEFAULT_S) * 1000;
}

/** 进程内 in-flight 计数（按 kind 分桶；生产每进程一家，测试可并行两家）。 */
const inflightByKind: Record<AttachKind, number> = {
  "claude-code": 0,
  codex: 0,
};

export function attachInflightCount(kind: AttachKind): number {
  return inflightByKind[kind];
}

/** @internal 测试重置 / 占位。 */
export function _resetAttachInflightForTest(kind?: AttachKind): void {
  if (kind) {
    inflightByKind[kind] = 0;
    return;
  }
  inflightByKind["claude-code"] = 0;
  inflightByKind.codex = 0;
}

/** @internal 测试占位 in-flight。 */
export function _setAttachInflightForTest(kind: AttachKind, n: number): void {
  inflightByKind[kind] = Math.max(0, Math.floor(n));
}

/** 目录 0700（recursive mkdir + chmod，跨平台 mode 参数不可靠时 chmod 兜底）。 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows 等可能无 chmod 语义 */
  }
}

/** 统计 attach root 占用（lstat，不跟随 symlink；只计常规文件）。 */
export function duAttachRoot(kind: AttachKind, root = attachDir(kind)): number {
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
        /* 单文件失败不挡 */
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

export async function materializeAttachment(
  kind: AttachKind,
  ref: AttachmentRefLike,
): Promise<string> {
  const url = String(ref.url ?? "");
  await validateDownloadUrl(url); // 早拒:scheme / 字面私网

  const maxInf = attachMaxInflight(kind);
  if (inflightByKind[kind] >= maxInf) {
    throw new Error(`附件並發下載達上限 ${maxInf}`);
  }
  inflightByKind[kind] += 1;

  const u = new URL(url);
  const isLocalHttp = u.protocol === "http:"; // validateDownloadUrl 已限 http 仅 localhost
  const mod = u.protocol === "https:" ? https : http;
  const root = attachDir(kind);
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
    // #1006:先占住 .part 再走网络。GC 见空 id 目录就拆；旧顺序 mkdir→GET(秒级)→open
    // 会被并发 GC rmdir，回来 ENOENT（Hermes 现场；CC/Codex 同构，节流 10min 只是更少中）。
    try {
      fd = openSync(tmpPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    } catch (e) {
      throw new Error(
        `無法創建附件臨時文件:${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`,
      );
    }

    const used = duAttachRoot(kind, root);
    const quota = attachQuotaBytes(kind);
    if (used >= quota) {
      throw new Error(`附件磁盤配額已滿 ${used}/${quota} 字節`);
    }

    // #249 node http/https 默认**不跟随重定向**(不同于 fetch)→ 顺带堵死 redirect-based SSRF;
    // https 连接挂 pinnedLookup 校验实际 IP,消除 rebinding TOCTOU。localhost dev 走 http 不 pin。
    const res: IncomingMessage = await new Promise((resolve, reject) => {
      const req = mod.get(
        url,
        {
          headers: { "user-agent": attachUserAgent(kind) },
          ...(isLocalHttp ? {} : { lookup: pinnedLookup }),
        },
        (r) => {
          const code = r.statusCode ?? 0;
          if (code >= 300) {
            r.resume(); // 排空,免 socket 挂住
            return reject(new Error(`下載失敗/拒重定向 HTTP ${code}`));
          }
          resolve(r);
        },
      );
      req.on("error", reject);
      req.setTimeout(60_000, () => req.destroy(new Error("下載超時")));
    });

    // Content-Length 早拒:带头且超 DOWNLOAD_MAX / 配额 → 不写盘
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

    if (fd == null) throw new Error("無法創建附件臨時文件");
    out = createWriteStream(tmpPath, { fd, autoClose: true, mode: 0o600 });
    fd = undefined; // 所有权交给 stream
    out.on("error", () => {
      /* pipeline 会把错误上抛;避免 destroy 竞态变成 unhandled */
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
    inflightByKind[kind] = Math.max(0, inflightByKind[kind] - 1);
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
        /* partial 可能尚未创建 */
      }
    }
  }
}

/** #151 入站附件 TTL GC:prompt 早已消费,超时即删(默认 6h,env 可调)。结构固定两层
 *  attachDir/<id>/<file>;删过期文件、清空的 id 目录。health tick 调用(节流 10min)。
 *  #383:lstat 不跟随 symlink;清 symlink/未知/过期 `.part` 残留;目录保持 0700。 */
const lastGcAtByKind: Record<AttachKind, number> = {
  "claude-code": 0,
  codex: 0,
};

/** @internal 测试重置 GC 节流。 */
export function _resetAttachGcForTest(kind?: AttachKind): void {
  if (kind) {
    lastGcAtByKind[kind] = 0;
    return;
  }
  lastGcAtByKind["claude-code"] = 0;
  lastGcAtByKind.codex = 0;
}

export function gcAttachments(kind: AttachKind, now = Date.now()): number {
  if (now - lastGcAtByKind[kind] < GC_THROTTLE_MS) return 0;
  lastGcAtByKind[kind] = now;
  let removed = 0;
  const root = attachDir(kind);
  const ttlMs = attachTtlMs(kind);
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
        // 不跟随 symlink;根下非目录杂物直接清
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
          if ((isPart && age > PART_STALE_MS) || (!isPart && age > ttlMs)) {
            unlinkSync(p);
            removed += 1;
          }
        } catch {
          /* 单文件失败不挡 */
        }
      }
      if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 单目录失败不挡全局 */
    }
  }
  return removed;
}
