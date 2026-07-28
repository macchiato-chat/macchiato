"""#423 會話工作目錄(cwd)的校驗——與 TS 兩家 cwd.ts 對齊。

背景/威脅:server 下發的 `session.create.cwd` 舊實現只 `strip()` 就寫入 `_cwds` 並透傳
gateway,**零校驗**(無 realpath / 存在性 / 目錄身份 / allowlist)。在「server 不可信」的
E2E 威脅模型下這是本地擴權面。

邊界(2026-07-25 人類 review 定調:安全收益要拿,但**不動用戶的路徑**;#404 返工後):
  - **默認工作目錄不動**:Hermes 未下發 cwd 時仍不注入專用工作區(gateway / 進程默認),
    也不改成 `~/.macchiato/*-workspace`。`MACCHIATO_HERMES_WORKDIR` 僅作可選本機覆蓋
    (與 CC/Codex 的 `MACCHIATO_*_WORKDIR` 同形,供操作者自選),未設時空 cwd = 不覆寫。
  - **硬校驗只針對「server 顯式下發的 cwd」**:realpath(解析 symlink 逃逸)+ 存在性 +
    是目錄,任一不過 → fail closed(不寫 `_cwds`、不傳 gateway、回明確提示)。
  - **未下發 cwd**:本機操作者自己的選擇,不在「server 不可信」威脅面內 → 不做
    allowlist 收緊;原樣視為「無 per-session 覆寫」。
  - **可選 allowlist**(`MACCHIATO_HERMES_ALLOWED_ROOTS`,冒號分隔)——opt-in,預設不啟用,
    且**只約束顯式下發的 cwd**。三態:
      · 未設 / 只有空白 → 不限根(默認;保 #227「自由文件夾」語義);
      · 設了且有可用根 → 顯式 cwd 的 realpath 必須落在某根內,否則拒;
      · 設了但**全部根不可解析**(盤沒掛 / 路徑打錯)→ **顯式 cwd 一律拒**(fail closed,
        絕不因為安全配置壞掉就退化成不限根)。
    三態都不影響「不下發 cwd」的會話。
  - **回合中改 cwd**:合法路徑照常記下(busy 時 gateway 4009 由既有邏輯吞),不在這裡
    因「回合進行中」而拒——對齊 #404 返工(不要 mid-turn reject)。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional


def default_work_dir() -> str:
    """本機默認工作目錄:`MACCHIATO_HERMES_WORKDIR` 覆蓋,否則 HOME。純算路徑,不碰 fs。

    注意:Hermes 未下發 cwd 時**不**把這個路徑塞給 gateway(保持「無 per-session 覆寫」);
    此函數主要供 allowlist / 文檔 / 未來顯式默認對齊,與 CC/Codex 同形。
    """
    return os.environ.get("MACCHIATO_HERMES_WORKDIR") or os.path.expanduser("~")


def expand_home(p: str) -> str:
    """~ / ~/... 展開為絕對路徑(不觸碰 fs 解析 symlink)。"""
    if p == "~":
        return os.path.expanduser("~")
    if p.startswith("~/"):
        return os.path.join(os.path.expanduser("~"), p[2:])
    return p


def allowed_roots() -> Optional[list[str]]:
    """`MACCHIATO_HERMES_ALLOWED_ROOTS`(冒號分隔)→ realpath 後的允許根。**只用於顯式 cwd**。

    - **未設 / 只有空白** → `None` = 不限根;
    - **設了但全部根不可解析** → `[]` = 顯式 cwd 一律拒(fail closed,絕不退化成不限根)。
    """
    raw = (os.environ.get("MACCHIATO_HERMES_ALLOWED_ROOTS") or "").strip()
    if not raw:
        return None
    roots: list[str] = []
    declared = 0
    for part in raw.split(":"):
        p = part.strip()
        if not p:
            continue
        declared += 1
        try:
            # 對齊 Node realpathSync:路徑不存在/不可解析 → 當壞根跳過。
            # 注意 Python os.path.realpath 對「末段不存在」的 POSIX 路徑仍回正規化字串
            # 且不拋,必須另查存在性,否則全壞根會退化成「帶幽靈路徑的 allowlist」。
            expanded = expand_home(p)
            if not os.path.exists(expanded):
                continue
            canon = os.path.realpath(expanded)
            if not os.path.isdir(canon):
                continue
            roots.append(canon)
        except OSError:
            # 壞根跳過:其餘可用根照舊生效;全壞則下面回 [](收緊,不是放開)
            pass
    return roots if declared else None  # 只寫了分隔符/空白 = 等同沒配


def _within(root: str, target: str) -> bool:
    """target 是否在 root 之內(邊界安全:同路徑或以 root+sep 為前綴,防 /a/bc 誤判在 /a/b 內)。"""
    if target == root:
        return True
    prefix = root if root.endswith(os.sep) else root + os.sep
    return target.startswith(prefix)


@dataclass(frozen=True)
class CwdResolution:
    ok: bool
    """ok:可交給 gateway 的工作目錄(顯式 cwd 為 realpath 規範路徑);
    空字串 = 未下發/清除 per-session 覆寫。否則:嘗試解析到的路徑(供提示)。"""
    cwd: str
    reason: Optional[str] = None


def resolve_cwd(raw: Optional[str]) -> CwdResolution:
    """解析並校驗會話工作目錄。

    - 空/未設 → ok,cwd=""(無 per-session 覆寫;不做 realpath/allowlist);
    - 顯式下發 → realpath + 存在性 + 是目錄 + allowlist,任一不過 → ok=False + reason(fail closed)。
    """
    trimmed = (raw or "").strip()
    if not trimmed:
        return CwdResolution(ok=True, cwd="")

    wanted = expand_home(trimmed)
    try:
        canon = os.path.realpath(wanted)  # 解析 symlink → 真實路徑
    except OSError:
        return CwdResolution(ok=False, cwd=wanted, reason=f"工作目錄不存在或不可解析:{wanted}")

    # realpath 對不存在路徑在 POSIX 上仍可能返回「正規化後的字串」而不拋;
    # 必須再查存在性 + 目錄身份。
    if not os.path.exists(canon):
        return CwdResolution(ok=False, cwd=wanted, reason=f"工作目錄不存在或不可解析:{wanted}")
    try:
        if not os.path.isdir(canon):
            return CwdResolution(ok=False, cwd=canon, reason=f"不是目錄:{canon}")
    except OSError:
        return CwdResolution(ok=False, cwd=canon, reason=f"工作目錄不可訪問:{canon}")

    roots = allowed_roots()
    if roots is not None and not any(_within(r, canon) for r in roots):
        if roots:
            reason = f"工作目錄不在允許根內(MACCHIATO_HERMES_ALLOWED_ROOTS):{canon}"
        else:
            reason = f"配置的允許根均不可用(檢查掛載/路徑),已拒絕下發的工作目錄:{canon}"
        return CwdResolution(ok=False, cwd=canon, reason=reason)

    return CwdResolution(ok=True, cwd=canon)
