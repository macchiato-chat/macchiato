/**
 * #378 抗 symlink / TOCTOU 的「具名文件」讀寫原語（Projects 的 AGENTS.md / CLAUDE.md 專用）。
 *
 * 威脅：Projects 只允許具名 AGENTS.md/CLAUDE.md，但舊實現的文件原語能被越界利用——
 *  - 讀：`readFileSync` 跟隨符號連結 → 惡意項目把 AGENTS.md 設成指向 `~/.ssh/id_rsa` 的 symlink，
 *    `mem_read` 就把同用戶任意文件讀出去；
 *  - 寫：固定臨時名 `<file>.tmp` 先跟隨預置 symlink 再 rename → 可覆寫同用戶任意文件；
 *  - 目錄本身可在備案後被換成 symlink / 替身目錄（TOCTOU）。
 *
 * 對策（對齊 #378 驗收）：
 *  - 目錄身份：備案時 realpath + dev/ino 指紋釘住，每次操作前重驗（擋目錄被換成 symlink/替身）；
 *  - **符號連結不再一律拒，而是「安全解析 + 包含性檢查」**（2026-07-25 人類 review 定調：用 dotfiles
 *    symlink 管 CLAUDE.md 的用戶必須能正常用）：realpath 解析目標 → **斷言目標仍在本 project 備案目錄
 *    樹內** → 對解析後的**真實路徑**做 `O_NOFOLLOW` 打開 + `fstat` 校驗。目標落到項目目錄外 → 拒（那是
 *    真越界）；
 *  - 打開後 `fstat` 確認常規文件、非硬連結（nlink===1），且 **dev/ino 與解析時的一致**——保證打開的就是
 *    「校驗那一刻確實坐在項目樹內的那個 inode」，中途被換路徑/換文件都會被抓到；
 *  - 讀：先按 `st.size` 限尺寸再分配（不讀完整文件再 slice），硬上限 `maxBytes`；
 *  - 寫：**寫穿到解析後的真實路徑**（symlink 因此得以保留，不會被 rename 換成常規文件），走該目錄下的
 *    **隨機**臨時名 + `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`（O_EXCL 令預置 symlink / 搶佔失敗）、權限
 *    0600，rename 前**再驗一次目錄身份**（自身 + 目標所在目錄）。
 *
 * 侷限（如實記錄，不粉飾）：
 *  - Node 無原生 openat/dirfd，故以「realpath + dev/ino 指紋重驗 + 末段 O_NOFOLLOW + fstat 指紋比對」
 *    作平台等價；項目樹**內部**的中間路徑段仍有殘留 TOCTOU 窗口（收窄而非消滅）。
 *  - **硬連結擋得住讀、擋不住「曾經是」**：讀路徑靠 `nlink===1` 拒絕硬連結（項目內對項目外文件的硬連結
 *    因此讀不到）；但硬連結本身在 fs 層無「原始位置」可查，若 nlink 恰為 1（原文件已被刪）就與普通文件
 *    無異——這種情況擋不住，就是擋不住。寫路徑不寫穿硬連結（rename 換 inode），故無覆寫穿透問題。
 */
import { openSync, readSync, writeSync, fstatSync, lstatSync, statSync, closeSync, renameSync, unlinkSync, realpathSync, constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, sep } from "node:path";

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;

/** 備案時凍結的可信目錄身份：realpath 規範路徑 + dev/ino 指紋。 */
export interface DirIdentity {
  canon: string;
  dev: number;
  ino: number;
}

/** target 是否在 root 之內（邊界安全：以 root+sep 為前綴，防 /a/bc 誤判在 /a/b 內；root 自身不算「內」）。 */
function withinDir(root: string, target: string): boolean {
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** realpath + stat 取目錄身份（dev/ino）。不存在 / 不是目錄 → 拋錯。 */
export function dirIdentity(path: string): DirIdentity {
  const canon = realpathSync(path);
  const st = statSync(canon);
  if (!st.isDirectory()) throw new Error(`不是目錄:${canon}`);
  return { canon, dev: st.dev, ino: st.ino };
}

/** 操作前重驗目錄身份：canon 未被換成 symlink，且仍是同一 dev/ino 的目錄。否則拋錯。 */
export function assertDirIdentity(id: DirIdentity): void {
  const ls = lstatSync(id.canon);
  if (ls.isSymbolicLink()) throw new Error(`拒絕:可信目錄被換成符號連結(${id.canon})`);
  const st = statSync(id.canon);
  if (!st.isDirectory() || st.dev !== id.dev || st.ino !== id.ino) {
    throw new Error(`拒絕:可信目錄身份已變(${id.canon})`);
  }
}

/** 具名項安全解析的結果（symlink 已解析、且已確認落在項目樹內）。 */
export interface ResolvedNamed {
  /** 實際要讀寫的絕對路徑（symlink 則為解析後的真實路徑）。 */
  path: string;
  /** 是否經由符號連結抵達。 */
  viaSymlink: boolean;
  /** 解析時的類型/指紋：常規文件 + dev/ino（打開後用 fstat 比對，擋「校驗↔打開」之間掉包）。 */
  isFile: boolean;
  dev: number;
  ino: number;
}

/**
 * 安全解析備案目錄下的具名項：不存在 → null；是符號連結 → realpath 解析並**斷言目標仍在備案目錄樹內**
 * （越界 / 斷鏈一律拋錯）。返回的 path 之末段在解析那一刻**確定不是符號連結**（後續 open 帶 O_NOFOLLOW
 * 再驗一次）。
 */
export function resolveNamed(id: DirIdentity, name: string): ResolvedNamed | null {
  assertDirIdentity(id);
  const entry = join(id.canon, name);
  let ls;
  try {
    ls = lstatSync(entry);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (!ls.isSymbolicLink()) {
    return { path: entry, viaSymlink: false, isFile: ls.isFile(), dev: ls.dev, ino: ls.ino };
  }
  let target: string;
  try {
    target = realpathSync(entry); // 整條連結鏈解析到底
  } catch {
    throw new Error(`拒絕:${name} 是斷開的符號連結(目標不可解析)`);
  }
  // 包含性檢查:目標必須仍在**本 project 備案目錄樹內**——dotfiles 在項目內做軟連結照用,
  // 指到項目外(~/.ssh/id_rsa、別人的倉庫…)就是真越界,拒。
  if (!withinDir(id.canon, target)) {
    throw new Error(`拒絕:${name} 的符號連結目標在項目目錄外(${target})`);
  }
  const ts = lstatSync(target); // realpath 之後末段必非 symlink;取指紋供 open 後比對
  return { path: target, viaSymlink: true, isFile: ts.isFile(), dev: ts.dev, ino: ts.ino };
}

/**
 * 按解析結果打開文件並校驗：O_NOFOLLOW（末段被換成 symlink → ELOOP）+ fstat（常規文件、非硬連結、
 * dev/ino 與解析時一致）。文件在解析後被刪 → null。
 */
function openVerified(r: ResolvedNamed, name: string): number | null {
  let fd: number;
  try {
    fd = openSync(r.path, O_RDONLY | O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new Error(`拒絕讀取:${name} 在校驗與打開之間被換成符號連結`);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`拒絕讀取:${name} 不是常規文件`);
    if (st.nlink !== 1) throw new Error(`拒絕讀取:${name} 是硬連結(nlink=${st.nlink})`);
    if (st.dev !== r.dev || st.ino !== r.ino) throw new Error(`拒絕讀取:${name} 在校驗與打開之間被替換`);
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/** 安全讀具名文件（symlink 解析+包含性檢查+O_NOFOLLOW+指紋比對）；不存在 → null；按大小上限讀取。 */
export function readNamedFile(id: DirIdentity, name: string, maxBytes: number): string | null {
  const r = resolveNamed(id, name);
  if (!r) return null;
  const fd = openVerified(r, name);
  if (fd === null) return null;
  try {
    const size = Math.min(Number(fstatSync(fd).size), maxBytes); // #378 先量後配，不讀完整文件再 slice
    const buf = Buffer.allocUnsafe(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * 具名文件的字節大小(同讀路徑的安全性);不存在 → null。
 * 用途:「超限就整體拒絕」的場景——絕不能先讀出**截斷版**再落盤(遷移場景會把超出部分永久丟)。
 */
export function namedFileSize(id: DirIdentity, name: string): number | null {
  const r = resolveNamed(id, name);
  if (!r) return null;
  const fd = openVerified(r, name);
  if (fd === null) return null;
  try {
    return Number(fstatSync(fd).size);
  } finally {
    closeSync(fd);
  }
}

/**
 * 原子寫具名文件：**寫穿到解析後的真實路徑**（項目內的 symlink 因此保留，dotfiles 照用），
 * 走該目錄下的隨機臨時名 + O_EXCL|O_NOFOLLOW + 0600，rename 前再驗目錄身份。
 */
export function writeNamedFileAtomic(id: DirIdentity, name: string, content: string): void {
  const r = resolveNamed(id, name); // 內含 assertDirIdentity；越界 symlink 在此就拒
  if (r && !r.isFile) throw new Error(`拒絕寫入:${name} 不是常規文件`);
  const target = r?.path ?? join(id.canon, name);
  const base = basename(target);
  const parentPath = dirname(target);
  // 目標所在目錄同樣釘身份：rename 前重驗，擋「解析後把中間目錄換掉」的 TOCTOU。
  const parent = parentPath === id.canon ? id : dirIdentity(parentPath);
  if (parent !== id && !withinDir(id.canon, parent.canon)) {
    throw new Error(`拒絕寫入(${name}):目標目錄在項目目錄外(${parent.canon})`);
  }
  const tmp = join(parent.canon, `.${base}.${randomBytes(9).toString("hex")}.tmp`);
  let fd: number;
  try {
    fd = openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`拒絕寫入臨時文件(${name}):${code ?? (e as Error).message}`);
  }
  let renamed = false;
  try {
    const buf = Buffer.from(content, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    closeSync(fd);
    assertDirIdentity(id);
    if (parent !== id) assertDirIdentity(parent);
    renameSync(tmp, join(parent.canon, base));
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        closeSync(fd);
      } catch { /* 已關 */ }
      try {
        unlinkSync(tmp);
      } catch { /* 清理盡力 */ }
    }
  }
}

/** 具名項的可用形態（symlink 安全解析後判定）：不存在 / 常規文件 / 其他（目錄、設備…）。 */
export function namedKind(id: DirIdentity, name: string): "absent" | "file" | "other" {
  const r = resolveNamed(id, name);
  if (!r) return "absent";
  return r.isFile ? "file" : "other";
}
