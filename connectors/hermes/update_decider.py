"""#669 階段 4/5:自動更新的**決策層**——純函數,無副作用,零依賴(只用 stdlib)。

**為什麼要獨立成一個模塊,而不是寫在 `macchiato-supervise.sh` 的 bash 分支裡**:

supervisor 是整條自愈鏈裡「沒有上游能修它」的那一環(#669 評論第一節)——它壞了 = 那台機器
永久失去所有自動修復能力。所以它必須保持極薄。而「該不該升、為什麼不升」恰恰是全鏈**分支
最多、邊界最刁**的一段:過期 / 同版 / 黑名單 / 分批 / 閒時,每條都有「判不出來」的第三態。
把它塞進 bash 就等於把最需要被逐條測試的邏輯,放進最測不動的地方。

於是切成兩層:**判定是純函數(本檔,被 pytest 逐分支覆蓋)**,**I/O 全在調用方**(拉檔案、
讀心跳、跑 install.sh)。本檔因此:不讀網絡、不讀寫檔案、不碰 `os.environ`、不看牆鐘——
連「現在幾點」都是參數。同一組輸入永遠得到同一個輸出,測試不需要 mock 任何東西。

**唯一的預設是「不升」。** 任何輸入缺失 / 畸形 / 判不出來,一律回 `update=False` 並帶一個
理由碼。`decide_update()` 本身**永不拋異常**:調用方是 supervisor,一個未捕獲的 traceback
在那裡會變成「這台機器從此不再檢查更新」。

**每條「不升」都帶可觀測的理由碼**(見 `DECISION_REASONS`)。將來要能回答「為什麼這台沒升」
——分批放量的剎車決策唯一的輸入就是這個(#669 評論 §四(b))。

⚠️ **本模塊不做任何驗簽**。`policy` 必須是 `release_verify.verify_policy()` 的返回值,
`manifest_version` 必須來自 `verify_manifest()` 過的清單。傳進未驗證的東西 = 把整條供應鏈
信任鏈短路掉。刻意不在這裡順手 import `release_verify`:supervisor 是用 importlib 從一條
**運行時發現**的路徑載入驗簽器的(可能不在本檔旁邊),硬 import 會讓決策器在那條路徑上炸。
兩邊的嚴格 semver 解析各自獨立實現,由 `tests/test_update_decider.py` 的等價性測試釘住。
"""
from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import NamedTuple, Optional

# ── 理由碼:這是可觀測性契約,值一旦發出去就別改字面量 ──────────────────────────────
REASON_UPDATE = "update"
"""全部判據通過——可以升。"""
REASON_BAD_INPUT = "bad-input"
"""本機側輸入畸形(本機版本 / installId / 目標版本 / 時刻)。"""
REASON_NO_POLICY = "no-policy"
"""沒有策略可用(拉不到 / 驗簽沒過,調用方傳 None)。"""
REASON_BAD_POLICY = "bad-policy"
"""策略結構不對或 schema 不認識。"""
REASON_POLICY_VERSION_MISMATCH = "policy-version-mismatch"
"""策略談的版本 ≠ 清單裡會裝的版本——剎車閘對不上目標,不敢升。"""
REASON_STALE_POLICY = "stale-policy"
"""策略已過期(TUF freeze:有人拿合法簽名的舊策略把機器凍住)。"""
REASON_UP_TO_DATE = "up-to-date"
"""目標版本 ≤ 本機版本。"""
REASON_BLOCKED = "blocked"
"""目標版本在策略黑名單或本機黑名單裡(試用期失敗過)。"""
REASON_BLOCKLIST_UNKNOWN = "blocklist-unknown"
"""本機黑名單讀不出來——可能正好漏掉一條「這版會磚」,寧可不升。"""
REASON_NOT_IN_ROLLOUT = "not-in-rollout"
"""本機不在這一批放量裡。"""
REASON_BUSY = "busy"
"""心跳說有進行中的回合或待審批——重啟會殺掉用戶正在跑的東西。"""
REASON_HEARTBEAT_UNKNOWN = "heartbeat-unknown"
"""心跳讀不到 / 過期 / 缺字段 / 時鐘跳變——**一律當忙**,絕不當閒。"""

DECISION_REASONS = (
    REASON_UPDATE,
    REASON_BAD_INPUT,
    REASON_NO_POLICY,
    REASON_BAD_POLICY,
    REASON_POLICY_VERSION_MISMATCH,
    REASON_STALE_POLICY,
    REASON_UP_TO_DATE,
    REASON_BLOCKED,
    REASON_BLOCKLIST_UNKNOWN,
    REASON_NOT_IN_ROLLOUT,
    REASON_BUSY,
    REASON_HEARTBEAT_UNKNOWN,
)

# ── 常量 ──────────────────────────────────────────────────────────────────────
POLICY_SCHEMA = 1
"""與 `release_verify.RELEASE_POLICY_SCHEMA` 同一個數;不認識的 schema → 停在原地不升。"""

DEFAULT_HEARTBEAT_MAX_AGE_S = 300.0
"""心跳最大年齡(秒)。連接器每 30s 寫一次(`MACCHIATO_HEALTH_S`),5 min 容得下十次漏寫;
超過就當「這份快照不代表現在」→ 未知 → 當忙。與 #673 supervisor 的新鮮度口徑一致。"""

CLOCK_SKEW_TOLERANCE_S = 60.0
"""心跳時間戳允許領先「現在」的幅度。超過 = 時鐘跳變/檔案被塞——未知,不是閒。"""

_MAX_BLOCKED_ENTRIES = 256
"""與 `release_verify._MAX_BLOCKED_VERSIONS` 同口徑;本機黑名單也套同一個上限。"""

_STRICT_SEMVER_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
# 與 #673 落盤的 installId 同一條規則(connector.py `_INSTALL_ID_RE` /
# connector-core `identity.ts`)。這裡再查一次,是因為分桶種子畸形 = 分桶失去意義。
_INSTALL_ID_RE = re.compile(r"^[0-9a-zA-Z._-]{8,128}$")
_UTC_TIMESTAMP_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$")
_MAX_SAFE_INTEGER = 2**53 - 1


class UpdateDecision(NamedTuple):
    """決策結果。`reason` 是穩定的機讀理由碼,`detail` 只給人看(日誌/排障)。"""

    update: bool
    reason: str
    target_version: Optional[str] = None
    detail: str = ""


# ── 小工具(全部私有、全部純) ─────────────────────────────────────────────────────
def _semver_key(version) -> Optional[tuple]:
    """嚴格 X.Y.Z(無前導零、無 pre-release)。畸形回 None——調用方一律據此拒絕升級。

    上限與 JS `Number.MAX_SAFE_INTEGER` 對齊,跨實現(TS/Python)比較不失真。
    """
    if not isinstance(version, str):
        return None
    match = _STRICT_SEMVER_RE.fullmatch(version)
    if match is None:
        return None
    parts = tuple(int(x) for x in match.groups())
    if any(x > _MAX_SAFE_INTEGER for x in parts):
        return None
    return parts


def _parse_utc_timestamp(value) -> Optional[float]:
    """只認 RFC3339 的 UTC 秒級時間戳;寬鬆解析會吞掉時區與 2026-02-30 這類不存在的日期。"""
    if not isinstance(value, str) or _UTC_TIMESTAMP_RE.fullmatch(value) is None:
        return None
    try:
        moment = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:  # 2026-02-30 / 25 時 之類
        return None
    return moment.timestamp()


def _is_finite_number(value) -> bool:
    """有限的實數。`bool` 是 `int` 的子類,而 `True` 當時刻用是純粹的 bug——一併擋掉。"""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        # Python 的 int 無上限,`math.isfinite(10**400)` 直接 OverflowError;
        # 時刻/年齡不可能超過安全整數,越界的就是垃圾輸入。
        return abs(value) <= _MAX_SAFE_INTEGER
    if isinstance(value, float):
        return math.isfinite(value)
    return False


def rollout_bucket(install_id: str) -> int:
    """本機在 0–99 裡的**穩定**分桶。

    **必須穩定**:同一台機器每次算出同一個桶。否則把 `rolloutPercent` 從 5 調到 10 時,
    機器會在「在批 / 不在批」之間亂跳——已經升上去的又被判成不該升,放量比例失去單調性,
    也就沒法拿它當剎車。故用 sha256 而**不是** Python 內建 `hash()`:後者按進程隨機加鹽
    (PYTHONHASHSEED),同一台機器每次重啟都會換桶。

    種子只有 `installId`(#673 落在 `~/.macchiato/install-id`,首次生成後持久化)。
    取前 8 個字節當大端整數再取模——sha256 輸出均勻,模 100 的偏差在 2^64 尺度上可忽略。

    畸形 installId 拋 ValueError:調用方(`decide_update`)已在前面攔掉,不會走到這裡。
    """
    if not isinstance(install_id, str) or _INSTALL_ID_RE.fullmatch(install_id) is None:
        raise ValueError(f"installId 不合法:{install_id!r}")
    digest = hashlib.sha256(install_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % 100


def _normalize_blocklist(entries) -> Optional[frozenset]:
    """本機黑名單 → 版本集合;任何一項可疑就回 None(= 未知 → 不升)。

    嚴格是有意的:黑名單的語義是「這版裝了會磚」,讀不乾淨時**寧可漏一次升級,不可漏一條
    黑名單**。空集合(檔案不存在 = 沒拉黑過任何版本)是完全正常的,與「讀不出來」不同。
    """
    if entries is None:
        return None
    if isinstance(entries, (str, bytes)) or not isinstance(entries, Iterable):
        return None
    out = set()
    for item in entries:
        if _semver_key(item) is None:
            return None
        out.add(item)
        if len(out) > _MAX_BLOCKED_ENTRIES:
            return None
    return frozenset(out)


def _heartbeat_verdict(heartbeat, now: float, max_age_s: float):
    """回 (是否閒, 理由碼 or None, 說明)。

    **判不出來一律當忙**,這是 #669 失敗矩陣裡明文寫死的一行:「閒時判據讀不到 → 當作忙,
    跳過本輪;**絕不允許**當作閒直接重啟」。誤判成閒 = 在用戶回合跑到一半時殺進程。
    """
    if not isinstance(heartbeat, dict):
        return False, REASON_HEARTBEAT_UNKNOWN, "沒有心跳快照"
    ts = heartbeat.get("ts")
    if not _is_finite_number(ts):
        return False, REASON_HEARTBEAT_UNKNOWN, "心跳缺 ts 或格式不對"
    age = now - float(ts)
    if age > max_age_s:
        return False, REASON_HEARTBEAT_UNKNOWN, f"心跳過期 {age:.0f}s > {max_age_s:.0f}s"
    if age < -CLOCK_SKEW_TOLERANCE_S:
        return False, REASON_HEARTBEAT_UNKNOWN, f"心跳時間戳領先現在 {-age:.0f}s(時鐘跳變?)"
    busy = heartbeat.get("busy")
    pending = heartbeat.get("pendingApproval")
    # 老連接器沒有這兩個字段 → get 回 None → 未知 → 當忙(而不是當閒)。
    if not isinstance(busy, bool) or not isinstance(pending, bool):
        return False, REASON_HEARTBEAT_UNKNOWN, "心跳缺 busy/pendingApproval(舊連接器?)"
    if busy:
        return False, REASON_BUSY, "有進行中的回合"
    if pending:
        return False, REASON_BUSY, "有待用戶審批的工具調用"
    return True, None, "空閒"


# ── 決策器本體 ────────────────────────────────────────────────────────────────
def _decide(
    policy,
    manifest_version,
    current_version,
    install_id,
    heartbeat,
    now,
    local_blocked,
    heartbeat_max_age_s,
) -> UpdateDecision:
    # ── 0. 本機側輸入(這些畸形說明調用方或本機狀態壞了,一律不升)──────────────
    if not _is_finite_number(now):
        return UpdateDecision(False, REASON_BAD_INPUT, None, "now 不是有限數")
    if not _is_finite_number(heartbeat_max_age_s) or heartbeat_max_age_s < 0:
        return UpdateDecision(False, REASON_BAD_INPUT, None, "heartbeat_max_age_s 不合法")
    current_key = _semver_key(current_version)
    if current_key is None:
        return UpdateDecision(False, REASON_BAD_INPUT, None, f"本機版本不合法:{current_version!r}")
    target_key = _semver_key(manifest_version)
    if target_key is None:
        return UpdateDecision(False, REASON_BAD_INPUT, None, f"清單版本不合法:{manifest_version!r}")
    if not isinstance(install_id, str) or _INSTALL_ID_RE.fullmatch(install_id) is None:
        return UpdateDecision(False, REASON_BAD_INPUT, manifest_version, "installId 不合法")

    # ── 1. 策略必須存在且看得懂 ────────────────────────────────────────────────
    # 這裡重查一遍 `verify_policy` 已經查過的字段,是刻意的:決策器可能被別的調用方複用,
    # 而「策略字段不是我以為的類型」在這一層的後果是**裝錯版本**,不是報個錯了事。
    if policy is None:
        return UpdateDecision(False, REASON_NO_POLICY, manifest_version, "沒有可用策略")
    if not isinstance(policy, dict):
        return UpdateDecision(False, REASON_BAD_POLICY, manifest_version, "策略不是物件")
    schema = policy.get("schema")
    if isinstance(schema, bool) or not isinstance(schema, int):
        return UpdateDecision(False, REASON_BAD_POLICY, manifest_version, "schema 不是整數")
    if schema != POLICY_SCHEMA:
        return UpdateDecision(
            False, REASON_BAD_POLICY, manifest_version, f"不支援的 schema:{schema}"
        )
    policy_version = policy.get("version")
    if _semver_key(policy_version) is None:
        return UpdateDecision(False, REASON_BAD_POLICY, manifest_version, "策略 version 不合法")
    rollout = policy.get("rolloutPercent")
    if isinstance(rollout, bool) or not isinstance(rollout, int) or not 0 <= rollout <= 100:
        return UpdateDecision(False, REASON_BAD_POLICY, manifest_version, "rolloutPercent 不合法")
    policy_blocked = _normalize_blocklist(policy.get("blocked"))
    if policy_blocked is None:
        return UpdateDecision(False, REASON_BAD_POLICY, manifest_version, "策略 blocked 不合法")
    expires = _parse_utc_timestamp(policy.get("expires"))
    if expires is None:
        return UpdateDecision(False, REASON_BAD_POLICY, manifest_version, "策略 expires 不合法")

    # ── 2. 策略談的必須就是要裝的那一版 ────────────────────────────────────────
    # 對不上就沒有剎車:`set-rollout.mjs` 把 rolloutPercent 改 0 是針對**某個版本**簽的,
    # 若清單已經走到下一版而策略還停在上一版,照著舊策略放量等於閘門形同虛設。
    if policy_version != manifest_version:
        return UpdateDecision(
            False,
            REASON_POLICY_VERSION_MISMATCH,
            manifest_version,
            f"策略談 v{policy_version},清單是 v{manifest_version}",
        )

    # ── 3. 新鮮度(TUF freeze attack)────────────────────────────────────────────
    # 放在版本比較**之前**:一份過期的策略連「該不該信它談的版本」都回答不了。
    if now >= expires:
        return UpdateDecision(
            False,
            REASON_STALE_POLICY,
            manifest_version,
            f"策略已於 {policy.get('expires')} 過期",
        )

    # ── 4. 版本:只向前,同版重放也不動 ─────────────────────────────────────────
    if target_key <= current_key:
        relation = "=" if target_key == current_key else "<"
        return UpdateDecision(
            False,
            REASON_UP_TO_DATE,
            manifest_version,
            f"目標 v{manifest_version} {relation} 本機 v{current_version}",
        )

    # ── 5. 黑名單:策略側 + 本機側 ─────────────────────────────────────────────
    # 本機黑名單是防「翻烙餅」的那一半(#669 §四(a)):沒有它,一個壞版本會變成
    # 「升級 → 試用失敗 → 回退 → 下輪又升級」的無限循環,比不自動更新還糟。
    if manifest_version in policy_blocked:
        return UpdateDecision(
            False, REASON_BLOCKED, manifest_version, f"v{manifest_version} 在策略黑名單裡"
        )
    machine_blocked = _normalize_blocklist(local_blocked)
    if machine_blocked is None:
        return UpdateDecision(
            False, REASON_BLOCKLIST_UNKNOWN, manifest_version, "本機黑名單讀不出來"
        )
    if manifest_version in machine_blocked:
        return UpdateDecision(
            False, REASON_BLOCKED, manifest_version, f"v{manifest_version} 在本機黑名單裡"
        )

    # ── 6. 分批放量 ───────────────────────────────────────────────────────────
    bucket = rollout_bucket(install_id)
    if not bucket < rollout:
        return UpdateDecision(
            False,
            REASON_NOT_IN_ROLLOUT,
            manifest_version,
            f"分桶 {bucket} 不在前 {rollout}%",
        )

    # ── 7. 閒時(最後一道:前面全過了才值得問「現在方不方便重啟」)───────────────
    idle, reason, detail = _heartbeat_verdict(heartbeat, float(now), float(heartbeat_max_age_s))
    if not idle:
        return UpdateDecision(False, reason, manifest_version, detail)

    return UpdateDecision(
        True,
        REASON_UPDATE,
        manifest_version,
        f"v{current_version} → v{manifest_version}(分桶 {bucket} < {rollout}%,空閒)",
    )


def decide_update(
    *,
    policy,
    manifest_version,
    current_version,
    install_id,
    heartbeat,
    now,
    local_blocked=None,
    heartbeat_max_age_s: float = DEFAULT_HEARTBEAT_MAX_AGE_S,
) -> UpdateDecision:
    """該不該自動升到 `manifest_version`?回 `UpdateDecision`,**永不拋異常**。

    全部參數都是 keyword-only:這串參數裡有三個版本號形狀的字串,位置傳參遲早會錯位,
    而錯位的後果是靜默裝錯版本。

    參數:
      policy:            `release_verify.verify_policy()` 的返回值;拉不到/驗簽沒過傳 `None`。
                         ⚠️ 本函數**不驗簽**——傳未驗證的 dict = 供應鏈信任鏈短路。
      manifest_version:  已驗簽 `release.json` 裡的版本,也就是**真正會被裝上去的那一版**。
                         決策全程以它為目標;策略的 `version` 只用來確認「策略談的是這一版」。
      current_version:   本機當前連接器版本。
      install_id:        `~/.macchiato/install-id`(#673),分桶種子。
      heartbeat:         心跳快照(`~/.macchiato/health-<kind>.json` 解析出來的 dict);
                         讀不到就傳 `None` —— 會被判成「忙」,不是「閒」。
      now:               當前時刻(epoch 秒)。顯式傳入,本模塊不看牆鐘。
      local_blocked:     本機黑名單版本序列(`update-blocked.json`)。檔案不存在 → 傳 `()`;
                         檔案在但**讀不出來/解析不了** → 傳 `None` → 判 `blocklist-unknown`
                         不升。這兩種情況語義不同,別混。
      heartbeat_max_age_s: 心跳最大年齡,預設 5 min。

    fail-safe 方向:任何一步判不出來都回 `update=False`,絕不回「升」。反過來也成立——
    本函數**永遠不會**要求調用方停止連接器 / 拒絕啟動,它只回答「升不升」這一個問題。
    """
    try:
        return _decide(
            policy,
            manifest_version,
            current_version,
            install_id,
            heartbeat,
            now,
            local_blocked,
            heartbeat_max_age_s,
        )
    except Exception as exc:  # 刻意吞掉一切:見下
        # 決策器跑在 supervisor 裡,而 supervisor 沒有上游能修它。一個沒接住的異常在那裡
        # = 這台機器從此不再檢查更新(靜默地)。任何漏網的邊界都退化成「本輪不升」+ 一條
        # 帶得走的說明,而不是 traceback。
        return UpdateDecision(False, REASON_BAD_INPUT, None, f"決策器內部異常:{exc!r}")
