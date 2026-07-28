/**
 * #392 會話工作目錄(cwd)的校驗。
 *
 * 背景/威脅:server 下發的 `session.create.cwd` 舊實現只 `trim()` 就透傳給 `query({ cwd })`,**零校驗**
 * (無 realpath / 存在性 / 目錄身份 / allowlist)。在「server 不可信」的 E2E 威脅模型下這是本地擴權面:
 * 配合 acceptEdits 檔(編輯類自動批)可靜默改用戶文件。
 *
 * 邊界(2026-07-25 人類 review 定調:安全收益要拿,但**不動用戶的路徑**):
 *  - **默認工作目錄仍是 HOME**(`MACCHIATO_CC_WORKDIR || homedir()`)。中途試過改成專用工作區,產品代價
 *    太大(所有「不帶 cwd」的存量會話集體換目錄、Codex 側沙箱根跟著收縮)——已撤銷,見 PR #404。
 *  - **硬校驗只針對「server 顯式下發的 cwd」**:realpath(解析 symlink 逃逸)+ 存在性 + 是目錄,任一不過
 *    → fail closed(不起回合、回明確提示)。正常用戶下發的都是真實存在的目錄,零感知。
 *  - **未下發 cwd → 本機默認**:那是連接器主機操作者自己的選擇(env / HOME),不在「server 不可信」的
 *    威脅面內,故**不做 allowlist 收緊**;只做與舊實現同樣的存在性檢查(env 打錯字時給明確提示)。
 *  - **可選 allowlist**(`MACCHIATO_CC_ALLOWED_ROOTS`,冒號分隔)——opt-in,預設不啟用,且**只約束顯式
 *    下發的 cwd**。三態:
 *      · 未設 / 只有空白 → 不限根(默認;保 #227「自由文件夾」語義);
 *      · 設了且有可用根 → 顯式 cwd 的 realpath 必須落在某根內,否則拒;
 *      · 設了但**全部根不可解析**(盤沒掛 / 路徑打錯)→ **顯式 cwd 一律拒**(fail closed,絕不因為安全
 *        配置壞掉就退化成不限根)。
 *    三態都不影響「不下發 cwd」的會話——它們照常在本機默認目錄跑,連接器不會因為配置壞掉而不可用。
 *
 * 已知取捨:默認 = HOME 意味著「不帶 cwd 的會話」仍可觸及整個 HOME(#392/#377 想收的那一半)。要收就配
 * `MACCHIATO_CC_WORKDIR` 指一個專用目錄——保持本機操作者說了算,連接器不替用戶改路徑。
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/** 本機默認工作目錄:`MACCHIATO_CC_WORKDIR` 覆蓋,否則 HOME。純算路徑,不碰 fs。 */
export function defaultWorkDir(): string {
  return process.env.MACCHIATO_CC_WORKDIR || homedir();
}

/** ~ / ~/... 展開為絕對路徑(不觸碰 fs)。 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * `MACCHIATO_CC_ALLOWED_ROOTS`(冒號分隔)→ realpath 後的允許根。**只用於顯式下發的 cwd。**
 *  - **未設 / 只有空白** → `null` = 不限根(保 #227「自由文件夾」語義);
 *  - **設了但全部根不可解析**(盤沒掛 / 路徑打錯)→ `[]` = 顯式 cwd 一律拒。
 *    絕不能在這種情況回 null——配置壞掉退化成「完全不限根」是 fail-open,方向反了。
 */
export function allowedRoots(): string[] | null {
  const raw = process.env.MACCHIATO_CC_ALLOWED_ROOTS?.trim();
  if (!raw) return null;
  const roots: string[] = [];
  let declared = 0;
  for (const part of raw.split(":")) {
    const p = part.trim();
    if (!p) continue;
    declared++;
    try {
      roots.push(realpathSync(expandHome(p)));
    } catch {
      /* 壞根跳過:其餘可用根照舊生效;全壞則下面回 [](收緊,不是放開) */
    }
  }
  return declared ? roots : null; // 只寫了分隔符/空白 = 等同沒配
}

/** target 是否在 root 之內(邊界安全:同路徑或以 root+sep 為前綴,防 /a/bc 誤判在 /a/b 內)。 */
function within(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

export interface CwdResolution {
  ok: boolean;
  /** ok:可直接交給 CLI 的工作目錄(顯式 cwd 為 realpath 規範路徑);否則:嘗試解析到的路徑(供提示)。 */
  cwd: string;
  reason?: string;
}

/**
 * 解析並校驗會話工作目錄。
 *  - 空/未設 → 本機默認(env / HOME),原樣返回,只查存在性(不 realpath、不查 allowlist);
 *  - 顯式下發 → realpath + 存在性 + 是目錄 + allowlist,任一不過 → ok:false + reason(fail closed)。
 */
export function resolveCwd(raw: string | undefined): CwdResolution {
  const trimmed = raw?.trim();
  if (!trimmed) {
    // 未下發 cwd:本機操作者自己的選擇,不受 server 影響 → 不做 realpath/allowlist 收緊。
    // 存在性檢查與舊實現(startTurn 的 isDir)等價,只為 env 打錯字時給明確提示。
    const base = defaultWorkDir();
    try {
      if (!statSync(base).isDirectory()) return { ok: false, cwd: base, reason: `不是目錄:${base}` };
    } catch {
      return { ok: false, cwd: base, reason: `工作目錄不存在或不可訪問:${base}` };
    }
    return { ok: true, cwd: base };
  }
  const wanted = expandHome(trimmed);
  let canon: string;
  try {
    canon = realpathSync(wanted); // 解析 symlink → 真實路徑(逃逸也解析到真實位置後再判 allowlist)
  } catch {
    return { ok: false, cwd: wanted, reason: `工作目錄不存在或不可解析:${wanted}` };
  }
  try {
    if (!statSync(canon).isDirectory()) return { ok: false, cwd: canon, reason: `不是目錄:${canon}` };
  } catch {
    return { ok: false, cwd: canon, reason: `工作目錄不可訪問:${canon}` };
  }
  const roots = allowedRoots();
  if (roots !== null && !roots.some((r) => within(r, canon))) {
    const reason = roots.length
      ? `工作目錄不在允許根內(MACCHIATO_CC_ALLOWED_ROOTS):${canon}`
      : `配置的允許根均不可用(檢查掛載/路徑),已拒絕下發的工作目錄:${canon}`;
    return { ok: false, cwd: canon, reason };
  }
  return { ok: true, cwd: canon };
}
