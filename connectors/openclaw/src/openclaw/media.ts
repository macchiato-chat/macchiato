/**
 * #158 出站附件 + #372 capability-bound 路徑校驗:
 * agent 回覆正文裡 `MEDIA:<路徑>` 標記 → 讀文件(12MB 上限)→ media.attach 事件
 * (base64 內聯,server 落存儲+渲染 media block)。
 *
 * 威脅:模型正文不是可信授權邊界;prompt injection 可誘導打印 `/etc/hosts`、
 * `~/.ssh/*` 等,舊實現只要文件存在就上傳。
 *
 * 對策(#372 務實落地):
 *  - **只認 `MEDIA:` 標記**(禁用裸絕對路徑自動上傳,降低誤報與注入面);
 *  - 路徑必須落在「會話允許根」內:session cwd / macchiato 管理目錄 / 附件目錄 /
 *    `MACCHIATO_MEDIA_ALLOW_ROOTS`(冒號分隔額外根,測試與本機擴展用);
 *  - `realpath` 解析 symlink 後做包含性檢查(逃逸根外 → 拒);
 *  - `O_NOFOLLOW` 打開 + `fstat` 確認常規文件 + size 上限(縮 TOCTOU)。
 * 失敗只記 reason / path_len,不 dump 路徑正文或文件內容(#381 對齊)。
 */
import {
  openSync,
  readSync,
  fstatSync,
  closeSync,
  lstatSync,
  realpathSync,
  statSync,
  constants,
} from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { homedir } from "node:os";

export const MEDIA_MAX = 12 * 1024 * 1024;
/** 冒號分隔的額外允許根(測試 / 本機 agent 輸出目錄白名單)。 */
export const MEDIA_ALLOW_ROOTS_ENV = "MACCHIATO_MEDIA_ALLOW_ROOTS";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/** MEDIA: 標記(整行,顯式意圖)。裸絕對路徑不再自動上傳(#372)。 */
const MEDIA_RE = /^MEDIA:\s*(\S.*?)\s*$/gm;

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function expand(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** target 是否在 root 之內(邊界安全:同路徑或以 root+sep 為前綴,防 /a/bc 誤判在 /a/b 內)。 */
export function withinRoot(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/**
 * 彙總當前會話的允許根(realpath 後的目錄;不存在/不可解析的跳過)。
 * 空列表 = fail closed(任何路徑都拒)。
 */
export function resolveMediaAllowRoots(opts?: {
  sessionCwd?: string | null;
  extraRoots?: readonly string[];
}): string[] {
  const candidates: string[] = [];
  const cwd = opts?.sessionCwd?.trim();
  if (cwd) candidates.push(expand(cwd));

  const state =
    (process.env.MACCHIATO_STATE_DIR || "").trim() || join(homedir(), ".macchiato");
  candidates.push(state);
  candidates.push(join(state, "attachments"));

  const raw = (process.env[MEDIA_ALLOW_ROOTS_ENV] || "").trim();
  if (raw) {
    for (const part of raw.split(":")) {
      const p = part.trim();
      if (p) candidates.push(expand(p));
    }
  }
  if (opts?.extraRoots) {
    for (const r of opts.extraRoots) {
      const p = r?.trim();
      if (p) candidates.push(expand(p));
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    try {
      const canon = realpathSync(c);
      if (!statSync(canon).isDirectory()) continue;
      if (seen.has(canon)) continue;
      seen.add(canon);
      out.push(canon);
    } catch {
      /* 不存在 / 不可解析 → 跳過該根 */
    }
  }
  return out;
}

/**
 * 將候選路徑規範化並校驗是否落在允許根內且為常規文件。
 * 成功 → realpath;失敗 → null(不拋,由調用方記 reason)。
 */
export function resolveAllowedMediaPath(
  rawPath: string,
  roots: readonly string[],
): string | null {
  if (!roots.length) return null;
  const expanded = expand(rawPath.trim());
  if (!expanded) return null;
  let canon: string;
  try {
    canon = realpathSync(expanded);
  } catch {
    return null;
  }
  if (!roots.some((r) => withinRoot(r, canon))) return null;
  try {
    // realpath 之後末段必非 symlink;再 lstat 確認是常規文件(拒目錄/裝置/socket)。
    const ls = lstatSync(canon);
    if (!ls.isFile()) return null;
  } catch {
    return null;
  }
  return canon;
}

function logDenied(reason: string, pathLen: number): void {
  console.error(`[media denied] reason=${reason} path_len=${pathLen}`);
}

/** 從回覆正文提取待投遞的本地文件路徑(僅 MEDIA: ;去重;必須落在允許根內)。 */
export function extractMediaPaths(text: string, roots: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!roots.length) return out;
  for (const m of text.matchAll(MEDIA_RE)) {
    const raw = (m[1] ?? "").trim();
    if (!raw) continue;
    const canon = resolveAllowedMediaPath(raw, roots);
    if (!canon || seen.has(canon)) continue;
    seen.add(canon);
    out.push(canon);
  }
  return out;
}

export interface MediaPayload {
  kind: "image" | "document";
  name: string;
  mime: string;
  size: number;
  data_b64: string;
}

/** 讀文件成 media.attach payload;根外/超限/非常規/讀失敗 → null。 */
export function readMediaFile(path: string, roots: readonly string[]): MediaPayload | null {
  const pathLen = path.length;
  const canon = resolveAllowedMediaPath(path, roots);
  if (!canon) {
    logDenied("outside_roots_or_missing", pathLen);
    return null;
  }

  let fd: number;
  try {
    fd = openSync(canon, OPEN_FLAGS);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") logDenied("symlink_race", pathLen);
    else logDenied("open_failed", pathLen);
    return null;
  }

  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      logDenied("not_regular_file", pathLen);
      return null;
    }
    const size = Number(st.size);
    if (size <= 0) {
      logDenied("empty", pathLen);
      return null;
    }
    if (size > MEDIA_MAX) {
      console.error(`[media too big] size=${size}B path_len=${pathLen}`);
      return null;
    }
    const buf = Buffer.allocUnsafe(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (off !== size) {
      logDenied("short_read", pathLen);
      return null;
    }
    const mime = MIME[extname(canon).toLowerCase()] ?? "application/octet-stream";
    return {
      kind: mime.startsWith("image/") ? "image" : "document",
      name: basename(canon),
      mime,
      size,
      data_b64: buf.toString("base64"),
    };
  } catch {
    logDenied("read_failed", pathLen);
    return null;
  } finally {
    closeSync(fd);
  }
}
