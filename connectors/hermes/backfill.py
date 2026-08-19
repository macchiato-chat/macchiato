#!/usr/bin/env python3
"""
Shared backfill helpers — enumerate importable Hermes history (design.md §11).

Used by connector.py (live feature: import_available + import_batch over Link B).

Source of truth: **~/.hermes/state.db** (SQLite). Hermes stopped writing
`~/.hermes/sessions/*.jsonl` around 2026-05-21 and moved to state.db, so the old
.jsonl path MISSES the recent month (incl. the bulk of Discord/Telegram chats).
state.db has the complete `sessions` + `messages` tables. We read it read-only
(Hermes writes it live) on a worker thread —— 讀者可能被寫者擋住，見 `_connect` 上方 #930。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import sys
import time

STATE_DB = os.path.expanduser("~/.hermes/state.db")
STALE_TURN_S = float(os.environ.get("MACCHIATO_STALE_TURN_S", "600"))  # 末行 tool_calls 久未結算→視為崩、強制結算

# Sources that are automation, not human↔agent conversations.
# "tui" = 連接器自己經 tui_gateway 驅動的會話（Macchiato 新建對話）→ 已由 live/drive 路徑投遞，
# 絕不能再鏡像（否則 server 用 state.db 的運行時 id 另建一條 → 同一對話翻倍；同事實測的 bug）。
# 用戶本機終端的 tui 會話也一併不鏡像（終端是本地、非外部消息平台）。結構化識別，取代舊的
# _rev/_fwd id 映射跳過——後者在 Hermes 0.18+ 失效：create_session 返回的 gateway 句柄 ≠ state.db
# 會話 id，mirror 看的是後者，永遠匹配不上。
# #592 "subagent":hermes 子代理的子會話——父會話的內部執行細節,絕不成為獨立會話(import 與鏡像同用)。
#   ⚠️ #948 起鏡像側**不再只靠這張黑名單**:子代理由 `_conversation_origins_sync` 判成
#   `kind='derived'`(結構化:`model_config.$._delegate_from` / `source='subagent'`,都是 Hermes
#   自己聲明的)並歸屬父會話,結論擋在 E2E 豁免**之前**——#592 那條「E2E + 已建立就放行」的特判
#   曾讓已鏡像過的 subagent 子會話從這張黑名單底下繞過去。這裡保留 "subagent" 是因為**導入路徑**
#   (`_kept_sessions` / `keepable`)沒有血緣上下文,且老 schema 缺列時它是唯一的判據。
# #938 Hermes 0.20 的機器對機器入口(逐個對拍上游 tag v2026.8.3 源碼確證,不是照文檔猜的)。
# 加進來的兩個,正好等於上游自己的隱藏集(`tools/session_search_tool.py` 的
# `_HIDDEN_SESSION_SOURCES` = kanban/subagent/tool),我們不比上游更激進:
#   "kanban" —— kanban dispatcher 派給 worker 子進程的跑批。hermes_cli/kanban_db.py 顯式
#       env["HERMES_SESSION_SOURCE"] = "kanban",原注釋:"it is not a conversation the user
#       started, so every session-browsing surface … filters it out by source"。
#   "tool"   —— 第三方集成自報的來源。hermes_cli/_parser.py 的 --source 幫助原文:
#       "Use 'tool' for third-party integrations that should not appear in user session lists";
#       上游自己在 session_search / tui_gateway session.list / desktop 側欄三處都硬過濾掉它。
#
# ⛔ 下面三個是**查證後刻意不加**的——判據是「只加定義上不可能有人在裡面說話的來源,拿不準＝不加」,
#    藏錯一個真實承載人話的來源 ＝ 用戶會話在 app 裡憑空消失,且是看不見的丟失。別再照 0.20 調研
#    文檔(docs/hermes-0.20.txt 條目 [6])把它們提一遍:
#   "a2a"     —— 事實層面它確實是機器入口(plugins/platforms/a2a 的 Platform("a2a");每條入站文本
#       都被 security.wrap_inbound() 打上 "[A2A inbound — message from a remote agent peer …]")。
#       但**正因為它是 Platform**,它落在上游 tui_gateway/methods_session.py 那段設計聲明裡:
#       "Resume picker should surface human conversation sessions from every user-facing surface —
#        … all gateway platforms (including new ones not enumerated here) …";上游的 deny-list 是
#       刻意收窄到 {kanban, tool} 的,即上游考慮過並選擇了顯示 a2a。它在上游任何隱藏名單裡都不出現。
#   "webhook" —— 上游把它當**用戶可見的消息平台**:desktop 給它獨立側欄分區 + 標籤 "Webhook",
#       tui_gateway 的 resume picker 還有回歸測試斷言它必須出現("webhook sessions were being
#       hidden by the old allow-list")。機制上也全通用,用戶完全可以拿它橋接真人渠道。
#   "desktop" —— 真實用戶界面,不是自動化。要動得先單獨討論。
SKIP_SOURCES = {"cron", "scheduled", "system", "tui", "subagent", "kanban", "tool"}
# Belt-and-suspenders title filter (cron markers + our own test sessions).
TITLE_SKIP_RE = re.compile(
    r"running as a scheduled cron|scheduled cron|^\[?\s*IMPORTANT: ?You are running|\btest\b|測試|用一句話|用一句话",
    re.I,
)
# Hermes prefixes the sender handle on platform messages (Discord: "[briansun] 早").
# Strip a leading short [handle] tag (no internal spaces) so imported chats read cleanly.
# Deliberately won't match "[The user sent a voice message …]" (has spaces) — separate wrapper.
_SENDER_TAG_RE = re.compile(r"^\[[^\]\s]{1,30}\]\s*")


def _strip_sender_tag(text: str) -> str:
    return _SENDER_TAG_RE.sub("", text or "", count=1)


# Hermes Discord 適配層(2026-07 實庫取樣)在 user 消息前注入觸發消息 id 前導塊,供 agent 的
# discord 工具 reply/react/pin 定位:
#   [Triggering message id: `152…830` — use as `message_id` for reply/react/pin via the discord tools.]\n\n[briansun] 原話
# 機器殼,展示必剝;且它擋在行首會讓 [sender] tag 剝不掉(正則錨定 ^)——順序必須先於 sender tag。
_TRIGGER_PREAMBLE_RE = re.compile(r"^\[Triggering message id:[^\]]*\]\s*")


def _clean_user_text(text: str) -> str:
    """user 消息展示清洗(順序敏感):觸發前導塊 → 語音 wrapper → 說話人 tag。"""
    return _strip_sender_tag(_unwrap_voice(_TRIGGER_PREAMBLE_RE.sub("", text or "", count=1)))


# #12:Hermes 語音消息在 state.db 裡是 wrapper 形態(2026-07-12 實庫取樣):
#   [The user sent a voice message~ Here's what they said: "原話"]\n\n[handle] (The user sent a message with no text content)
# 展示只留「原話」;隨語音附帶的真實文字(若有)保留。
_VOICE_WRAPPER_RE = re.compile(
    r"\[The user sent a voice message~ Here's what they said: \"(.*?)\"\]", re.S
)
_VOICE_NO_TEXT_RE = re.compile(
    r"\[[^\]\s]{1,30}\]\s*\(The user sent a message with no text content\)"
)


def _unwrap_voice(text: str) -> str:
    if "voice message~" not in (text or ""):
        return text or ""
    t = _VOICE_WRAPPER_RE.sub(lambda m: m.group(1), text)
    t = _VOICE_NO_TEXT_RE.sub("", t)
    return t.strip()


# ── #930 併發讀：等鎖，別立刻炸 ────────────────────────────────────────────────
# Hermes 0.20 在受 WAL-reset bug 影響的 SQLite（3.7.0–3.51.2 ＝ 現網幾乎所有機器）上拒絕給
# **新建**的 state.db 開 WAL，落成 `journal_mode=DELETE`（已是 WAL 的老庫不降級）。差別是：
# WAL 下讀寫可並發，DELETE 下寫者提交那一刻整庫擋住讀者。於是新裝 / 新 profile 的用戶在
# Hermes 忙寫時，鏡像輪詢（每 2s 一輪）會撞 `database is locked` → 刷屏、整段停住，
# 嚴重時 mirrorLastPollAgeS 超閾值把連接器打降級 / 重啟。
#
# 對策只落在**我們這一側**：顯式 busy timeout（Python 默認也是 5s，這裡寫明並可調）+ 撞鎖
# 退避重試 + 日誌收斂。**絕不** `PRAGMA journal_mode=WAL` 去改用戶的庫——state.db 是 Hermes
# 的，我們只是借讀；也絕不要求用戶升 SQLite。
BUSY_TIMEOUT_S = float(os.environ.get("MACCHIATO_DB_BUSY_TIMEOUT_S", "5"))
LOCK_RETRIES = int(os.environ.get("MACCHIATO_DB_LOCK_RETRIES", "2"))  # 首次之外的重試次數
LOCK_BACKOFF_S = float(os.environ.get("MACCHIATO_DB_LOCK_BACKOFF_S", "0.25"))
LOCK_LOG_EVERY_S = 60.0  # 鎖日誌節流窗（被擋住時每 2s 一輪，不收斂就是刷屏）
JOURNAL_TTL_S = 300.0  # journal_mode 探測緩存（庫換模式極罕見，但別讓 health 掛着陳舊答案）

_JOURNAL_MODE = None  # 最近探到的 journal_mode（"wal" / "delete" / …）；None = 未知
_JOURNAL_DB = None  # 探測時的 STATE_DB 路徑（換庫 → 重探）
_JOURNAL_AT = 0.0
_LOCK_COUNTERS = {"dbLockRetries": 0, "dbLockFailures": 0}
_LOCK_LOG_STATE = {}  # 日誌類別 → [上次輸出時刻, 窗內抑制條數]


def journal_mode():
    """state.db 的 journal_mode（health 上報用）；未探到 → None。

    只回緩存、**絕不主動連庫**：`_health()` 跑在事件循環線程上，撞鎖時連庫會把整個連接器
    卡住 BUSY_TIMEOUT_S。值由 `_connect()` 在工作線程上順路探。"""
    return _JOURNAL_MODE


def lock_counters() -> dict:
    """#930 鎖等待/失敗計數（併進 health.counters；進程生命週期，重啟歸零）。"""
    return dict(_LOCK_COUNTERS)


def _is_locked(exc: BaseException) -> bool:
    """`database is locked` / `database is busy` / `database table is locked`。"""
    if not isinstance(exc, sqlite3.OperationalError):
        return False
    m = str(exc).lower()
    return "is locked" in m or "is busy" in m


def _log_lock(kind: str, msg: str) -> None:
    """鎖日誌收斂：同一類別每 LOCK_LOG_EVERY_S 最多一行，窗內的併成一個計數報出來。

    類別分開節流，是為了不讓吵的那條（每輪都有的「重試中」）把要緊的那條（「放棄了」）擠掉。"""
    now = time.monotonic()
    st = _LOCK_LOG_STATE.setdefault(kind, [0.0, 0])
    if st[0] and now - st[0] < LOCK_LOG_EVERY_S:
        st[1] += 1
        return
    extra = f"（另有 {st[1]} 條同類已抑制）" if st[1] else ""
    _LOCK_LOG_STATE[kind] = [now, 0]
    print(f"[state.db lock] {msg}{extra}", file=sys.stderr)


def _note_journal_mode(con: sqlite3.Connection) -> None:
    """順路探一次 journal_mode（TTL 內跳過）。探測本身要摸庫頭 → 也可能撞鎖：**永不上拋**，
    診斷位不許把正經讀取搞黃。失敗也記時間戳，免得每次連接都白等一輪 busy timeout。"""
    global _JOURNAL_MODE, _JOURNAL_DB, _JOURNAL_AT
    now = time.monotonic()
    if _JOURNAL_DB == STATE_DB and _JOURNAL_AT and now - _JOURNAL_AT < JOURNAL_TTL_S:
        return
    _JOURNAL_DB, _JOURNAL_AT = STATE_DB, now
    try:
        row = con.execute("PRAGMA journal_mode").fetchone()
    except sqlite3.Error:
        return
    if row and row[0]:
        _JOURNAL_MODE = str(row[0]).lower()


def _connect() -> sqlite3.Connection:
    """只讀打開 state.db，帶 busy timeout（見上 #930）。"""
    con = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=BUSY_TIMEOUT_S)
    try:
        # 顯式再釘一次：connect(timeout=) 與 PRAGMA 是同一個旋鈕，但寫明後不依賴 Python 版本默認。
        con.execute(f"PRAGMA busy_timeout = {int(BUSY_TIMEOUT_S * 1000)}")
        _note_journal_mode(con)
    except sqlite3.Error:
        con.close()
        raise
    return con


def _retry_locked(fn, *args):
    """跑一次讀取（連接 + 查詢），撞鎖就退避重試，重試耗盡才拋。

    重跑**整個函數**而不是單條語句：這些讀取都是冪等快照，重跑最省心，也不必動任何 SQL。"""
    delay = LOCK_BACKOFF_S
    for attempt in range(LOCK_RETRIES + 1):
        try:
            return fn(*args)
        except sqlite3.Error as exc:
            if not _is_locked(exc):
                raise
            if attempt >= LOCK_RETRIES:
                _LOCK_COUNTERS["dbLockFailures"] += 1
                _log_lock("gaveup", f"讀取被鎖擋住，{LOCK_RETRIES + 1} 次嘗試耗盡"
                                    f"（journal_mode={_JOURNAL_MODE or '?'}）：{exc}")
                raise
            _LOCK_COUNTERS["dbLockRetries"] += 1
            _log_lock("retry", f"讀取被寫者擋住（journal_mode={_JOURNAL_MODE or '?'}），"
                               f"{delay:.2f}s 後重試")
            time.sleep(delay)
            delay *= 2


def _keep(source, title, mcount) -> bool:
    if (source or "").lower() in SKIP_SOURCES:
        return False
    if title and TITLE_SKIP_RE.search(title):
        return False
    if not mcount:
        return False
    return True


def _kept_sessions(con: sqlite3.Connection) -> list:
    rows = con.execute(
        "select id, source, title, started_at, message_count, archived from sessions"
    ).fetchall()
    return [r for r in rows if _keep(r[1], r[2], r[4])]


# ── #929 Hermes 0.20：機器殼條目（display_kind）─────────────────────────────
# 0.20（state.db schema 25）給 messages 加了 display_kind / display_metadata：模型切換、
# 上下文壓縮交接、delegation 完成這類**機器殼**仍然存成 role='user'，但 Hermes 自己的
# CLI/TUI/desktop 都已不當用戶消息顯示——只剩我們還把它們當「用戶自己打的字」推給用戶。
# 規則：`hidden` 丟棄（根本不進對話），其餘標記行落 role="system"（客戶端居中的一行
# SystemNote，不落用戶氣泡、不計未讀）。
# 老庫（schema < 25）沒這兩列 → PRAGMA 探測後 SELECT 退化成 NULL，行為與今天完全一致，
# 不做遷移、不做版本門禁。
_DISPLAY_HIDDEN = "hidden"
# 護欄：萬一上游哪天給**普通消息**也打上標記，這些取值一律仍當用戶發言——否則 0.20 用戶
# 的所有氣泡會集體塌成系統行（比今天壞得多的失敗方向）。未知標記才降級成時間線事件。
_DISPLAY_PLAIN = {"user", "message", "text", "normal", "default", "chat", "none"}
# content 為空時，從 display_metadata（JSON）裡撈一句人話當事件正文。
_DISPLAY_META_KEYS = ("summary", "message", "text", "label", "description", "title")


def _display_select(con: sqlite3.Connection) -> str:
    """SELECT 用的兩列表達式；老庫無此列 → 退化成 NULL，行解析路徑不必分叉。"""
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(messages)")}
    except sqlite3.Error:
        cols = set()
    kind = "display_kind" if "display_kind" in cols else "NULL"
    meta = "display_metadata" if "display_metadata" in cols else "NULL"
    return f"{kind}, {meta}"


def _display_role(kind) -> str | None:
    """user 行的 display_kind → 落成什麼：'user'（真人發言）/ 'system'（時間線事件）/ None（丟棄）。"""
    k = (kind or "").strip().lower()
    if not k or k in _DISPLAY_PLAIN:
        return "user"
    if k == _DISPLAY_HIDDEN:
        return None
    return "system"


def _event_text(content, metadata) -> str:
    """機器殼行的展示正文：正文優先；空則從 display_metadata 撈一句人話；都沒有 → ''（丟棄）。
    機器殼不走 _clean_user_text（那套剝的是平台注入的人類消息外殼）。"""
    text = (content or "").strip()
    if text:
        return text
    try:
        meta = json.loads(metadata) if isinstance(metadata, (str, bytes)) else metadata
    except (ValueError, TypeError):
        return ""
    if not isinstance(meta, dict):
        return ""
    for key in _DISPLAY_META_KEYS:
        v = meta.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


# ── #942 就地壓縮（archive_and_compact）重插的逐字副本 ──────────────────────────
# Hermes 默認 `compression.in_place: true`（`agent/agent_init.py`），上下文寫滿就自動壓縮。
# `archive_and_compact()` 在**同一條 session id 上**、**一個事務裡**做兩件事：
#   ① `UPDATE messages SET active=0, compacted=1 WHERE session_id=? AND active=1` —— 舊行軟歸檔；
#   ② 把壓縮結果當**全新行**插進去（`_insert_message_rows`：id 是 AUTOINCREMENT、`active` 硬編碼 1）。
# ②那批裡除了一條摘要，還有 `protect_last_n`（默認 20）條**逐字保留**的近期消息。我們的去重鍵是
# state.db 行 id（`srcId` → server 側 `dedup_key`），副本 id 全新 → 一條都攔不住 → 用戶會話尾部
# 憑空多出約 20 條重複。上游真包實測（`scripts/hermes-real-probe/probe-compaction.py`，v2026.8.3）：
# 原 id 11–30 原樣回來成 srcId 32–51，條數恰好等於 `protect_last_n`；導入路徑更重（30 條原件 + 20
# 條副本一起讀出）。
#
# ⚠️ 判據**不是比正文**——那是 #939 / #942 都點名禁止的方向：用戶真發的重複話（「ok」「繼續」）
# 會被靜默吞掉，而丟消息這一側用戶看不見。這裡認的是**壓縮這個動作留下的結構化印記**，四條同時成立
# 才丟：
#   ① 這條會話**真的被就地壓縮過**——存在 `compacted=1` 的行。沒壓縮過的會話根本不進匹配。
#   ② 副本塊必然是「**緊接着重複前面已收下的那一段**」——`protect_last_n` 的語義就是「保留最後 n
#      條」，所以它逐字等於我們迄今認定的正文序列的**尾巴**：順序一致、位置連續、右端對齊。
#   ③ 被重複的那些正本**全部**帶 `compacted=1`（就是這次壓縮歸檔掉的那批）。壓縮之外的巧合重複
#      （用戶真的又說了一遍）落在 `compacted=0` 上，天然出局。
#   ④ 重複長度 ≥ `_COMPACT_MIN_RUN`。上游自己的保護尾巴下限是 `max(3, …)`
#      （`agent/context_compressor.py` 的 `min_tail_floor`），比它短的重複不當壓縮副本看。
# 任何一條不成立 → **一條都不丟** ＝ 今天的行為（用戶看見一段可解釋的重複）。與
# `_continuation_baseline_sync` 同一條保守原則：寧可讓用戶看見重複，也絕不靜默吞掉他的消息。
#
# 正本永遠贏（id 更小、且要麼已投遞過、要麼在同一批裡一起投）——所以這裡不看水位線，只認「誰是
# 副本」。多代壓縮天然成立：第 N 代的副本等於「第 N-1 代之後我們認定的正文序列」的尾巴，逐代匹配。
#
# 時間戳**刻意不進判據**。實測（`scripts/hermes-real-probe/README.md`）副本是否沿用原時間戳，取決於
# agent 的消息列表是從庫裡 load 的（`_rows_to_conversation` 會帶 `timestamp` → 逐字繼承）還是本進程
# 內存拼的（沒有 `timestamp` → 落壓縮時刻）——**兩種都存在**。而且上游自己在
# `get_messages_as_conversation` 的注釋裡寫明 `timestamp` 非單調（WSL2 / NTP / 睡眠喚醒）。靠不住的
# 信號不進判據。
_COMPACT_MIN_RUN = 3    # 對齊上游 min_tail_floor = max(3, …)
_COMPACT_MAX_RUN = 200  # 遠高於默認 protect_last_n=20；只是給匹配一個上界，避免病態會話上退化


def _compact_select(con: sqlite3.Connection) -> str:
    """`compacted` 列；老庫沒有 → NULL（＝ 判據①永不成立 ＝ 行為與今天逐字相同）。"""
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(messages)")}
    except sqlite3.Error:
        cols = set()
    return "compacted" if "compacted" in cols else "NULL"


def _copy_seq(rows: list) -> list:
    """`[(rid, role, content, display_kind, compacted)]` → 餵給 `_compaction_copy_ids` 的序列。
    剔除 `hidden` 機器殼（壓縮摘要就是這種，#929 已在投遞前丟掉）——它們根本不進對話，
    讓它們參與對齊只會把副本塊和正本錯開一位。"""
    return [
        (rid, role, content, cp)
        for (rid, role, content, dk, cp) in rows
        if role != "user" or _display_role(dk) is not None
    ]


def _compaction_copy_ids(seq: list) -> set:
    """`seq`：按 id 升序的 `[(rid, role, content, compacted)]`，只含**鏡像真會投遞的行**
    （user/assistant，已剔除 `display_kind='hidden'` 的機器殼）。返回判定為壓縮逐字副本、
    應當丟棄的 rid 集合。判據見上方大段注釋。"""
    if not any(cp for (_rid, _role, _content, cp) in seq):
        return set()  # 判據①：這條會話沒被就地壓縮過，一條都不動
    drop = set()
    kept = []  # 迄今認定的正文序列：[(key, compacted)]
    at = {}    # key → 它在 kept 裡的下標列表（升序）
    i, n = 0, len(seq)
    while i < n:
        rid, role, content, _cp = seq[i]
        key = (role, content or "")
        run = 0
        for p in at.get(key, ()):
            span = len(kept) - p  # 對齊到 kept 的尾巴：kept[p:] ←→ seq[i:i+span]
            if span > _COMPACT_MAX_RUN:
                continue  # 升序遍歷 → 先跳過過長的，後面的 span 只會更短
            if span < _COMPACT_MIN_RUN or i + span > n:
                break  # 判據④：再往後 span 更短，不必試了
            if all(
                kept[p + j][1] and kept[p + j][0] == (seq[i + j][1], seq[i + j][2] or "")
                for j in range(span)
            ):  # 判據②（逐字、同序、右端對齊）+ ③（正本全部 compacted=1）
                run = span
                break
        if run:
            drop.update(seq[i + j][0] for j in range(run))
            i += run
            continue
        at.setdefault(key, []).append(len(kept))
        kept.append((key, bool(_cp)))
        i += 1
    return drop


def _derive_title(con: sqlite3.Connection, sid: str) -> str:
    # #929 取首條**真人**發言：機器殼（display_kind）不配當標題（「模型已切換」不是會話主題）。
    rows = con.execute(
        f"select content, {_display_select(con)} from messages "
        "where session_id=? and role='user' and content!='' order by id limit 8",
        (sid,),
    ).fetchall()
    for content, kind, _meta in rows:
        if _display_role(kind) != "user" or not content:
            continue
        t = " ".join(_clean_user_text(str(content)).split())
        if t:
            return (t[:48] + "…") if len(t) > 48 else t
    return "(導入會話)"


def _tool_results(con: sqlite3.Connection, sid: str) -> dict:
    """tool_call_id → 結果正文（role='tool' 行）。"""
    res = {}
    for tcid, content in con.execute(
        "select tool_call_id, content from messages where session_id=? and role='tool'",
        (sid,),
    ):
        if tcid:
            res[tcid] = content or ""
    return res


def _parse_tool_calls(raw, results: dict) -> list:
    """assistant.tool_calls(JSON) → [{callId,name,input,output,state}]，output 由 tool_call_id 配上結果。"""
    if not raw:
        return []
    try:
        calls = json.loads(raw)
    except (ValueError, TypeError):
        return []
    out = []
    for c in calls if isinstance(calls, list) else []:
        if not isinstance(c, dict):
            continue
        cid = c.get("id") or c.get("call_id") or ""
        fn = c.get("function") if isinstance(c.get("function"), dict) else {}
        name = c.get("name") or fn.get("name") or "tool"
        inp = c.get("input")
        if inp is None:
            inp = c.get("arguments") if c.get("arguments") is not None else fn.get("arguments")
        res = results.get(cid)
        state = "ok"
        if res:
            head = res[:200].lstrip().lower().replace(" ", "")
            # 保守判定：結果本身是 error 對象、或顯式 success:false / is_error:true。
            # 不再用「正文出現 error」這種寬鬆匹配（會把成功結果裡的 error 字樣誤判）。
            if head.startswith('{"error"') or '"success":false' in head or '"is_error":true' in head or '"iserror":true' in head:
                state = "error"
        tc = {"callId": cid, "name": name, "state": state}
        if inp is not None:
            tc["input"] = inp
        if res is not None:
            tc["output"] = res
        out.append(tc)
    return out


def _read_messages(con: sqlite3.Connection, sid: str) -> list:
    results = _tool_results(con, sid)
    rows = list(con.execute(
        f"select id, role, content, reasoning, tool_calls, timestamp, {_display_select(con)}, "
        f"{_compact_select(con)} "
        "from messages where session_id=? and role in ('user','assistant') order by id",
        (sid,),
    ))
    # #942 就地壓縮重插的逐字副本：導入路徑不去掉的話，同一段對話會整段出現兩次
    # （實測 30 條原件 + 20 條副本一起讀出）。
    drop = _compaction_copy_ids(_copy_seq([(r[0], r[1], r[2], r[6], r[8]) for r in rows]))
    out = []
    for rid, role, content, reasoning, tool_calls, ts, dkind, dmeta, _cp in rows:
        if rid in drop:
            continue
        content = content or ""
        if role == "user":
            # #929 機器殼：hidden 丟棄，其餘落 system（時間線事件），只有無標記的才是用戶氣泡。
            kind = _display_role(dkind)
            if kind is None:
                continue
            if kind == "system":
                text = _event_text(content, dmeta)
                if text:
                    out.append({"role": "system", "text": text, "createdAt": ts})
                continue
            content = _clean_user_text(content)
            if content.strip():
                out.append({"role": "user", "text": content, "createdAt": ts})
        else:  # assistant
            tools = _parse_tool_calls(tool_calls, results)
            has_reason = bool(reasoning and str(reasoning).strip())
            if content.strip() or has_reason or tools:
                m = {"role": "agent", "text": content, "createdAt": ts}
                if has_reason:
                    m["reasoning"] = reasoning
                if tools:
                    m["tools"] = tools
                out.append(m)
        # skip tool / session_meta / system rows (tool 結果已折進 assistant)
    return out


# ── cron 輸出 → 訂閱 Feed（每個任務合成一條線；design.md §16）──────────────────
CRON_SYSTEM_RE = re.compile(
    r"^hermes-|auto.?update|watchdog|heartbeat|self.?test|health.?check|maintenance", re.I
)


def _job_name(title: str) -> str:
    # cron 標題格式 "<任務名> · <日期 時間>" → 取 · 前的任務名。
    return re.split(r"\s+·\s+", title or "", maxsplit=1)[0].strip()


def _cron_jobs(con: sqlite3.Connection) -> dict:
    """任務名 → [(sid, started_at)]（排除系統 cron，如 hermes-auto-update）。"""
    jobs: dict = {}
    for sid, title, started in con.execute(
        "select id, title, started_at from sessions where source='cron'"
    ):
        job = _job_name(title)
        if job and not CRON_SYSTEM_RE.search(job):
            jobs.setdefault(job, []).append((sid, started or 0))
    return jobs


def _cron_feed_count(con: sqlite3.Connection) -> int:
    return len(_cron_jobs(con))


def cron_feed_target(source, title):
    """用戶向 cron → 返回任務名（合成 feed id `cron:<job>`）；系統 cron / 非 cron → None。
    供連接器 tailer 把 live cron 運行併進對應 feed 線（design.md §16）。"""
    if (source or "").lower() != "cron":
        return None
    job = _job_name(title)
    if not job or CRON_SYSTEM_RE.search(job):
        return None
    return job


def _cron_feed_sessions(con: sqlite3.Connection) -> list:
    """每個 cron 任務合成一條 feed：合成 id cron:<任務名>，按時間堆每次運行的 agent 報告。"""
    out = []
    for job, runs in _cron_jobs(con).items():
        runs.sort(key=lambda r: r[1])
        messages = []
        for sid, _started in runs:
            for m in _read_messages(con, sid):
                # feed 只留 agent 的文字報告（去思考/工具步驟，純 digest）。
                if m["role"] == "agent" and (m.get("text") or "").strip():
                    messages.append(
                        {"role": "agent", "text": m["text"], "createdAt": m.get("createdAt")}
                    )
        if not messages:
            continue
        out.append(
            {
                "hermesSessionId": f"cron:{job}",
                # #969 合成 feed 不是一條源系統線程（多次運行併成一條），沒有血緣可言 →
                # 顯式 `absent`（＝ server 走老行為），不硬猜也不沉默。
                "origin": {
                    "threadId": f"cron:{job}",
                    "conversationId": f"cron:{job}",
                    "kind": "root",
                    "evidence": "absent",
                },
                "title": job,
                "source": "cron_feed",  # 繞過 server 對 source=cron 的過濾
                "archived": False,
                "messages": messages,
            }
        )
    return out


def _count_sync() -> int:
    con = _connect()
    try:
        return len(_kept_sessions(con)) + _cron_feed_count(con)
    finally:
        con.close()


def to_wire_origin(sid: str, origin: dict | None, *, merged: bool) -> dict:
    """#969/#985 本地血緣 → 協議 `ThreadOrigin`。

    `sid` = 這批消息的源 thread id。協議要求 `origin.threadId` ≡ 實際上報的
    `hermesSessionId`；`merged=True` 表示已經在本地併進別人（鏡像把壓縮續接掛到根），
    那批內容對 server 就是那條對話自己的 → 只能報 root。

    獨立 session（`merged=False`）據實報 kind。**導入例外**：壓縮續接的檔裡帶着交接塊
    （父歷史的副本），報 `continuation` 會讓新 server 把那段歷史再灌進父會話一遍——
    比列表裡多一行更傷。導入對非 root 因此仍走 `evidence: absent`（見 `import_origin`），
    不是謊報 root。鏡像側用 `continuation_baseline` 切掉交接塊之後才併，那是另一條路。
    """
    o = origin or {}
    evidence = o.get("evidence") or "declared"
    kind = o.get("kind") or "root"
    if evidence == "absent" or merged or kind == "root":
        return {
            "threadId": sid,
            "conversationId": sid,
            "kind": "root",
            "evidence": "absent" if evidence == "absent" else evidence,
        }
    conversation_id = o.get("conversationId") or sid
    ancestors = o.get("ancestors") or ()
    parent = ancestors[0] if ancestors else (conversation_id if conversation_id != sid else None)
    out = {
        "threadId": sid,
        "conversationId": conversation_id,
        "kind": kind,
        "evidence": evidence,
    }
    if parent and parent != sid:
        out["parentThreadId"] = parent
    return out


def import_origin(sid: str, origin: dict | None) -> dict:
    """#969 導入路徑上報的 `ThreadOrigin`。

    獨立根會話據實報 `root`。壓縮續接 / 派生**不報真 kind**：導入讀的是整檔（含交接塊
    副本），新 server 若按 continuation 並進父會話，用戶會在同一條對話裡看到雙份歷史。
    所以顯式 `evidence: absent`——「這條路給不出能讓 server 改行為的聲明」。
    老 schema 連血緣列都沒有 → `_origins_with_con` 已經給的就是 `absent`。
    """
    kind = (origin or {}).get("kind")
    evidence = (origin or {}).get("evidence", "declared")
    if kind is not None and kind != "root":
        evidence = "absent"
    return to_wire_origin(sid, {**(origin or {}), "evidence": evidence, "kind": "root"}, merged=False)


def _enumerate_sync() -> list:
    con = _connect()
    try:
        out = []
        kept = _kept_sessions(con)
        origins = _origins_with_con(con, [r[0] for r in kept])
        for sid, source, title, started_at, _mc, archived in kept:
            msgs = _read_messages(con, sid)
            if not msgs:
                continue
            out.append(
                {
                    "hermesSessionId": sid,
                    "origin": import_origin(sid, origins.get(sid)),
                    "title": title if (title and title.strip()) else _derive_title(con, sid),
                    "source": source,
                    "startedAt": started_at,
                    "archived": bool(archived),
                    "messages": msgs,
                }
            )
        out.extend(_cron_feed_sessions(con))
        return out
    finally:
        con.close()


# `*_args` keeps the old call sites (connector passes self.gw) working; gw is no longer needed.
# 每個 async 入口都經 `_retry_locked`（#930）——工作線程上等鎖，事件循環不受影響。
async def count_importable(*_args) -> int:
    return await asyncio.to_thread(_retry_locked, _count_sync)


async def enumerate_importable(*_args) -> list:
    return await asyncio.to_thread(_retry_locked, _enumerate_sync)


# ── §15 全渠道持續鏡像：增量讀取（連接器 tailer 用）──────────────────────────

def keepable(source, title) -> bool:
    """人類渠道過濾（只看 source/title，不看 message_count）；鏡像 tailer 用。"""
    if (source or "").lower() in SKIP_SOURCES:
        return False
    if title and TITLE_SKIP_RE.search(title):
        return False
    return True


def _current_max_id_sync() -> int:
    con = _connect()
    try:
        return con.execute("select coalesce(max(id), 0) from messages").fetchone()[0]
    finally:
        con.close()


# ── #948 會話血緣：身份 ＝ 壓縮鏈的根，不是 `sessions.id` ─────────────────────
# Hermes 聊長了觸發上下文壓縮時，`publish_compression_child()` 會**新建一條 session 行**
# （新 id、`parent_session_id` 指向舊的、逐字繼承 `session_key`/`chat_id`/`thread_id`/
# `display_name`/`origin_json`），並把父標記 `end_reason='compression'`。我們按 `sessions.id`
# 認身份 → app 裡原來那條停更、旁邊另起一條，**用戶感知為「歷史丟了」**。上游自己的 Web UI
# 早就按 lineage 折疊（`hermes_cli/web_routers/sessions.py` 的 `compression_root`/`lineage_tip`）。
#
# 判據**只走源系統聲明的結構化邊**，不碰時間戳/文本啟發式——上游踩過並已收斂：
# `get_compression_tip` 的 docstring 記着舊實現用 `child.started_at >= parent.ended_at` 判續接，
# *"That ordering is too brittle"*，症狀正是 *"the user's latest messages look 'lost'"*。
#
# 一條邊算「續接」當且僅當（逐條對齊上游 `get_compression_tip` 的 WHERE）：
#   父 `end_reason = 'compression'`，且子**不是** `_branched_from`（/branch 分支）、
#   **不是** `_delegate_from`（委派子代理）、**不是** `source='tool'`。
# 額外加一條我們自己的交叉校驗：`session_key` 是壓縮子會話**逐字繼承**的（見上），兩端都非空
# 卻不相等 ＝ 結構像壓縮、路由身份卻換了人，寧可不併。
#
# ⚠️ 分支 / 重置**不是**續接，別順手一起併：上游 v2026.8.13 的 `_LISTABLE_CHILD_SQL` 把
# branch 子（父 `end_reason='branched'`）和 reset 子（`_reset_from` / 同 `session_key` 且父
# `end_reason ∈ {session_reset, session_switch, idle, daily, …}`）都算**獨立的用戶對話**。
# 我們「父必須 `end_reason='compression'`」這一條天然把它們擋在外面——這是刻意的，不是漏的。
#
# 三個輸出各管一件事（與 codex #946 / claude-code #947 同語義，僅命名隨 #926 的表）：
#   - `conversationId` 決定**歸屬**：這條 session 行的內容落到哪一段對話（根 ＝ 自己）。
#   - `kind` 決定**可見性**：`root` 進列表；`continuation` 併進 `conversationId` 那一行；
#     `derived`（子代理/委派）是父會話的執行細節，**永不**成為獨立會話。
#   - `evidence` 決定**信誰**：`declared` ＝ 源系統寫了字段（hermes 這裡全是列，沒有靠猜的
#     `inferred`）；`absent` ＝ 老 schema 連列都沒有 → 一律回落成 `root`，行為與今天逐字節相同。
LINEAGE_MAX_HOPS = 100  # 對齊上游 get_compression_tip 的防禦上限（這麼深的鏈是病態）
# 血緣列。老 schema 缺列 → SELECT 退化成 NULL（同 `_display_select` 的做法），不做遷移、不做門禁。
# title_source 是上游 v2026.8.13 才加的（v2026.8.3 沒有）——所以它必須容缺，不能當前提。
_LINEAGE_COLS = ("parent_session_id", "end_reason", "session_key", "title_source", "model_config")
# 標題出處（上游 `TITLE_SOURCE_*`）的權威序：用戶改的名字 > 模型起的 > 首句派生 > 沒說。
_TITLE_RANK = {"user": 3, "llm": 2, "derived": 1}


def _session_cols(con: sqlite3.Connection) -> set:
    try:
        return {r[1] for r in con.execute("PRAGMA table_info(sessions)")}
    except sqlite3.Error:
        return set()


def _lineage_select(cols: set, alias: str = "s") -> str:
    """血緣五列的 SELECT 片段；缺列→NULL（老庫零行為變化）。"""
    return ", ".join(f"{alias}.{c}" if c in cols else "NULL" for c in _LINEAGE_COLS)


def _model_config(raw) -> dict:
    try:
        cfg = json.loads(raw) if isinstance(raw, (str, bytes)) else raw
    except (ValueError, TypeError):
        return {}
    return cfg if isinstance(cfg, dict) else {}


def _title_rank(source) -> int:
    return _TITLE_RANK.get((source or "").strip().lower(), 0)


def _lineage_supported_sync() -> bool:
    """這個 Hermes 版本的 `sessions` 表有沒有血緣列（`parent_session_id` / `end_reason`）。

    #969 上報 `ThreadOrigin.evidence` 要分得開兩件事：`declared`（源系統寫了字段，我們讀到了）
    與 `absent`（**那個版本壓根沒這個概念**）。沒有這條探測，老 schema 上就只能沉默——而
    「沉默」和「明確說不知道」在 server 的 `sessions_resolved_total{evidence}` 上分不開，
    那正是判斷「何時可以把判定權交給 server」的關鍵指標（#961）。
    """
    con = None
    try:
        con = _connect()
        cols = _session_cols(con)
        return "parent_session_id" in cols and "end_reason" in cols
    except sqlite3.Error as exc:
        if _is_locked(exc):
            raise  # 撞鎖交給 _retry_locked 重試，別當成「沒有這個列」
        return False  # 讀不到庫 → 按 absent（＝ 老行為），絕不假裝我們讀到了聲明
    finally:
        if con is not None:
            con.close()


async def lineage_supported() -> bool:
    return await asyncio.to_thread(_retry_locked, _lineage_supported_sync)


def self_origin(sid: str, evidence: str = "declared") -> dict:
    """快路徑：沒有父的會話就是它自己那段對話（絕大多數行走這裡，零額外查詢）。

    `evidence` 由調用方給（見 `lineage_supported()`）：老 schema 上是 `absent`——「我這個版本
    沒有血緣這個概念」，而不是「我看過了，它沒有父」。
    """
    return {
        "conversationId": sid,
        "kind": "root",
        "evidence": evidence,
        "title": None,
        "source": None,
        "sessionKey": None,
        "ancestors": [],
        "hops": 0,
    }


def _changed_sessions_sync(since: int = 0) -> list:
    """每個會話的 (sid, source, title, archived, max_msg_id, + 血緣五列)；caller 用各自水位線比對。
    #8:傳 since=全局最小水位線收窄掃描(只回有新消息的會話);0=全量(重啟推進等場景)。
    #948 尾部追加 parent_session_id / end_reason / session_key / title_source / model_config
    ——**追加在尾部**，老的下標訪問(r[0]/r[4])逐字不變。"""
    con = _connect()
    try:
        lin = _lineage_select(_session_cols(con))
        return con.execute(
            f"select s.id, s.source, s.title, s.archived, max(m.id), {lin} "
            "from sessions s join messages m on m.session_id = s.id "
            "where m.role in ('user','assistant','tool') and m.id > ? group by s.id",
            (since,),
        ).fetchall()
    finally:
        con.close()


def _sessions_meta_sync(sids: list) -> list:
    """(sid, source, title, archived, + 血緣五列) 批量補查——#8 收窄後,無新消息的已鏡像會話仍需
    偵測純標題更新(Hermes 回合後才取名),用主鍵 IN 輕量取 meta(無 messages join)。"""
    if not sids:
        return []
    ph = ",".join("?" * len(sids))
    con = _connect()
    try:
        lin = _lineage_select(_session_cols(con))
        return con.execute(
            f"select s.id, s.source, s.title, s.archived, {lin} "
            f"from sessions s where s.id in ({ph})",
            list(sids),
        ).fetchall()
    finally:
        con.close()


def _fetch_lineage_rows(con: sqlite3.Connection, cols: set, ids: list) -> dict:
    """按主鍵批量取血緣行（id → dict）。一跳一次 IN 查詢，鏈深通常 0–2。"""
    out = {}
    ids = [i for i in ids if i]
    for i in range(0, len(ids), 400):  # SQLITE_MAX_VARIABLE_NUMBER 保守分頁
        chunk = ids[i:i + 400]
        ph = ",".join("?" * len(chunk))
        lin = _lineage_select(cols)
        for row in con.execute(
            f"select s.id, s.source, s.title, {lin} from sessions s where s.id in ({ph})",
            chunk,
        ):
            out[row[0]] = {
                "id": row[0],
                "source": row[1],
                "title": row[2],
                "parent": row[3],
                "endReason": row[4],
                "sessionKey": row[5],
                "titleSource": row[6],
                "modelConfig": row[7],
            }
    return out


def _is_branch_row(row: dict) -> bool:
    return _model_config(row.get("modelConfig")).get("_branched_from") is not None


def _is_delegate_row(row: dict) -> bool:
    return _model_config(row.get("modelConfig")).get("_delegate_from") is not None


def _compression_root(rows: dict, start: str) -> tuple:
    """沿 `parent_session_id` 上溯，**只走 `end_reason='compression'` 的邊**。回 (根 id, 祖先鏈)。"""
    cur, chain = start, []
    seen = {cur}
    for _ in range(LINEAGE_MAX_HOPS):
        row = rows.get(cur)
        if row is None or not row.get("parent"):
            break
        # 分支 / 委派 / tool 子：結構上是另一回事，不並鏈（逐條對齊上游 get_compression_tip）。
        if _is_branch_row(row) or _is_delegate_row(row) or (row.get("source") or "").lower() == "tool":
            break
        parent = rows.get(row["parent"])
        if parent is None or (parent.get("endReason") or "") != "compression":
            break
        # 壓縮子會話逐字繼承父的 session_key；兩端都非空卻不等 → 不是同一條路由身份，停。
        if row.get("sessionKey") and parent.get("sessionKey") and row["sessionKey"] != parent["sessionKey"]:
            break
        if parent["id"] in seen:
            break
        seen.add(parent["id"])
        cur = parent["id"]
        chain.append(cur)
    return cur, chain


def _conversation_title(rows: dict, sid: str, root: str):
    """這段對話該顯示的標題：默認用**根**的（app 裡用戶已經看到的那個，不因壓縮而改名）；
    只有鏈尾的 `title_source` 權威更高（用戶自己改過名）才讓位給鏈尾。

    上游 v2026.8.13 在用戶把鏈尾改成祖先佔着的名字時，會**把標題從祖先轉移到鏈尾**（祖先
    title 置 NULL）——所以根標題為空時必須回落到鏈尾，否則用戶剛改的名字顯示不出來。"""
    tip, base = rows.get(sid) or {}, rows.get(root) or {}
    tip_title = (tip.get("title") or "").strip()
    base_title = (base.get("title") or "").strip()
    if tip_title and _title_rank(tip.get("titleSource")) > _title_rank(base.get("titleSource")):
        return tip_title
    return base_title or tip_title or None


def _origins_with_con(con: sqlite3.Connection, sids: list) -> dict:
    """`_conversation_origins_sync` 的內核，複用調用方已開的連接（導入路徑用）。"""
    sids = [s for s in sids if s]
    if not sids:
        return {}
    cols = _session_cols(con)
    if "parent_session_id" not in cols or "end_reason" not in cols:
        # 老 schema 連列都沒有：未知 ≠ 沒有 —— 一律回落成 root，維持今天的行為，不倒退。
        return {sid: self_origin(sid, "absent") for sid in sids}
    rows = _fetch_lineage_rows(con, cols, sids)
    # 逐跳把祖先拉進來（一跳一次 IN；正常鏈深 0–2，病態鏈由 LINEAGE_MAX_HOPS 兜底）。
    frontier = [r["parent"] for r in rows.values() if r.get("parent")]
    for _ in range(LINEAGE_MAX_HOPS):
        want = [p for p in frontier if p and p not in rows]
        if not want:
            break
        more = _fetch_lineage_rows(con, cols, want)
        if not more:
            break
        rows.update(more)
        frontier = [r["parent"] for r in more.values() if r.get("parent")]

    out = {}
    for sid in sids:
        row = rows.get(sid)
        if row is None:
            out[sid] = self_origin(sid)
            continue
        # 派生（子代理 / 委派）：它是父會話的執行細節，歸屬從**父**開始算。
        derived = _is_delegate_row(row) or (row.get("source") or "").lower() == "subagent"
        start = (row.get("parent") or sid) if derived else sid
        root, chain = _compression_root(rows, start)
        kind = "derived" if derived else ("continuation" if root != sid else "root")
        base = rows.get(root) or {}
        ancestors = chain if not derived else ([start] + chain if start != sid else chain)
        out[sid] = {
            "conversationId": root or sid,
            "kind": kind,
            "evidence": "declared",
            "title": None if root == sid else _conversation_title(rows, sid, root),
            "source": base.get("source"),
            "sessionKey": base.get("sessionKey"),
            # 從直接父到根的全部祖先（caller 用它問「這段對話我們鏡像過沒有」）。
            "ancestors": ancestors,
            "hops": len(chain),
        }
    return out


def _conversation_origins_sync(sids: list) -> dict:
    """一批 session id → 它們各自的 `{conversationId, kind, evidence, title, source, …}`。

    只該對「有父 / 自報派生」的行調用——沒有父的行走 `self_origin()` 快路徑，不打庫。"""
    if not [s for s in sids if s]:
        return {}
    con = _connect()
    try:
        return _origins_with_con(con, sids)
    finally:
        con.close()


async def conversation_origins(sids: list) -> dict:
    return await asyncio.to_thread(_retry_locked, _conversation_origins_sync, list(sids))


def _continuation_baseline_sync(sid: str) -> int:
    """壓縮子會話裡「交接塊」的邊界：返回可安全跳過的最大 raw id（0 ＝ 不跳）。

    `publish_compression_child()` 在**同一個事務**裡先把壓縮結果（摘要 + `protect_last_n`
    默認 20 條**逐字保留**的近期消息，見 `agent/context_compressor.py`）當新行插進子會話，
    再給父蓋 `ended_at`。這批行是父會話裡已鏡像內容的副本，但 id/dedup_key 全新 → server
    的 `(session_id, dedup_key)` 唯一索引認不出來，原樣投出去就是尾部憑空多出約 20 條重複。

    ⚠️ 這裡用時間戳**不是**上游警告的那種啟發式：上游踩的是「拿 started_at/ended_at 去猜
    哪個子會話才是續接」（跨行、跨進程競態）；這裡的邊只認結構化字段，時間戳只用來在**一條**
    會話內部、對着**同一個事務**寫下的 `ended_at` 切一刀，而且只切**開頭連續的那一段**
    （遇到第一行晚於邊界就停）。讀不到父 / 讀不到 `ended_at` / 任何 SQL 異常 → 回 0
    ＝ 什麼都不跳：寧可讓用戶看見一段可解釋的重複，也不靜默吞掉他的消息。"""
    con = _connect()
    try:
        row = con.execute(
            "select parent_session_id from sessions where id=?", (sid,)
        ).fetchone()
        if not row or not row[0]:
            return 0
        prow = con.execute(
            "select ended_at from sessions where id=?", (row[0],)
        ).fetchone()
        if not prow or prow[0] is None:
            return 0
        cut = float(prow[0])
        floor = 0
        for rid, ts in con.execute(
            "select id, timestamp from messages where session_id=? order by id", (sid,)
        ):
            if ts is None or float(ts) > cut:
                break
            floor = rid
        return floor
    except sqlite3.Error as exc:
        if _is_locked(exc):
            raise  # 撞鎖交給 _retry_locked 重試，別當成「讀不到」
        return 0
    except (TypeError, ValueError):
        return 0
    finally:
        con.close()


async def continuation_baseline(sid: str) -> int:
    return await asyncio.to_thread(_retry_locked, _continuation_baseline_sync, sid)


def _tail_session_sync(sid: str, since_id: int) -> tuple:
    """新增（raw id > since_id）的**已結算**消息 + 新水位線。折疊 tool 行；尾部 in-flight
    （最後一行是仍在調工具的 assistant）暫不鏡像、不推進水位線 → 下輪自愈。
    #942 就地壓縮重插的逐字副本在這裡丟掉（判據見 `_compaction_copy_ids`）。"""
    con = _connect()
    try:
        rows = list(con.execute(
            "select id, role, content, reasoning, tool_calls, tool_call_id, timestamp, finish_reason, "
            f"{_display_select(con)}, {_compact_select(con)} "
            "from messages where session_id=? and role in ('user','assistant','tool') order by id",
            (sid,),
        ))
        if not rows:
            return [], since_id
        tool_res, tool_rid = {}, {}
        for rid, role, content, _r, _tc, tcid, _ts, _fr, _dk, _dm, _cp in rows:
            if role == "tool" and tcid:
                tool_res[tcid] = content or ""
                tool_rid[tcid] = rid
        # #942 就地壓縮重插的逐字副本（tool 行不參與對齊：它們折進 assistant，不單獨投遞）。
        drop = _compaction_copy_ids(
            _copy_seq([(r[0], r[1], r[2], r[8], r[10]) for r in rows if r[1] != "tool"])
        )
        # in-flight：末行是仍在調工具的 assistant。但若它已很舊（>STALE_TURN_S，疑似 agent
        # 中途崩、那條 tool_calls 永無結果）則強制結算，避免該會話鏡像永久卡死（修 C）。
        last = rows[-1]
        inflight = last[1] == "assistant" and last[7] == "tool_calls"
        if inflight:
            try:
                if time.time() - float(last[6]) > STALE_TURN_S:
                    inflight = False
            except (TypeError, ValueError):
                pass
        # 副本被丟掉，但水位線照樣要越過它們——否則這條會話的水位線永遠停在壓縮之前，
        # `_changed_sessions_sync` 的全局最小水位線被它拖住，每輪掃描白白變寬。
        # 唯一例外是末行本身還在 in-flight：跟正常行一樣，留給下一輪。
        dropped_cover = 0
        folded = []  # (msg, cover_id)：cover = 該折疊消息覆蓋的最大 raw id（含其 tool 結果行）
        for rid, role, content, reasoning, tc, tcid, ts, fr, dkind, dmeta, _cp in rows:
            content = content or ""
            if rid in drop:
                if not (inflight and rid == last[0]):
                    cover = rid
                    for t in _parse_tool_calls(tc, tool_res):
                        cover = max(cover, tool_rid.get(t["callId"], rid))
                    dropped_cover = max(dropped_cover, cover)
                continue
            if role == "user":
                # #929 機器殼：hidden 丟棄，其餘落 system（時間線事件），只有無標記的才是用戶氣泡。
                kind = _display_role(dkind)
                if kind is None:
                    continue
                if kind == "system":
                    text = _event_text(content, dmeta)
                    if text:
                        folded.append((
                            {"role": "system", "text": text, "createdAt": ts, "srcId": str(rid)}, rid
                        ))
                    continue
                c = _clean_user_text(content)
                if c.strip():
                    # §9 srcId=state.db 消息 id（穩定）→ server 據此去重連接器崩潰重發
                    folded.append(({"role": "user", "text": c, "createdAt": ts, "srcId": str(rid)}, rid))
            elif role == "assistant":
                tools = _parse_tool_calls(tc, tool_res)
                has_reason = bool(reasoning and str(reasoning).strip())
                if content.strip() or has_reason or tools:
                    m = {"role": "agent", "text": content, "createdAt": ts, "srcId": str(rid)}
                    if has_reason:
                        m["reasoning"] = reasoning
                    if tools:
                        m["tools"] = tools
                    cover = rid
                    for t in tools:
                        cover = max(cover, tool_rid.get(t["callId"], rid))
                    folded.append((m, cover))
            # tool 行折進 assistant，跳過
        # in-flight 的末行不結算（上面已判定）：它是 folded 尾部那條 agent 時才需要摘掉。
        settled = (
            folded[:-1]
            if (inflight and folded and folded[-1][0]["role"] == "agent" and folded[-1][1] >= last[0])
            else folded
        )
        new_msgs = [m for (m, cover) in settled if cover > since_id]
        new_wm = max(since_id, dropped_cover)
        for (_m, cover) in settled:
            new_wm = max(new_wm, cover)
        return new_msgs, new_wm
    finally:
        con.close()


def _session_snapshot_sync(sid: str):
    """§19 D2 轉換回灌：某會話的**全量已結算**歷史 + 覆蓋的最大 raw id + 元數據。
    會話不在 state.db → None（如自驅 tui 會話 id 未解析，見 E2E-5）。"""
    con = _connect()
    try:
        row = con.execute(
            "select source, title, archived from sessions where id=?", (sid,)
        ).fetchone()
        if row is None:
            return None
        source, title, archived = row
        if not (title and title.strip()):
            title = _derive_title(con, sid)
    finally:
        con.close()
    msgs, cover = _tail_session_sync(sid, 0)
    return {
        "source": source,
        "title": title,
        "archived": bool(archived),
        "messages": msgs,
        "cover": cover,
    }


async def session_snapshot(sid: str):
    return await asyncio.to_thread(_retry_locked, _session_snapshot_sync, sid)


async def current_max_id() -> int:
    return await asyncio.to_thread(_retry_locked, _current_max_id_sync)


async def changed_sessions(since: int = 0) -> list:
    return await asyncio.to_thread(_retry_locked, _changed_sessions_sync, since)


async def sessions_meta(sids: list) -> list:
    return await asyncio.to_thread(_retry_locked, _sessions_meta_sync, sids)


def _turn_rows_sync(sid: str, since: int) -> list:
    """#13:某會話 id > since 的 (id, role) 行——回合結束後定位本回合寫進 state.db 的行。"""
    con = _connect()
    try:
        rows = con.execute(
            f"select id, role, {_display_select(con)} from messages where session_id=? and id>? "
            "and role in ('user','assistant') order by id",
            (sid, since),
        ).fetchall()
    finally:
        con.close()
    # #929 機器殼行不參與身份回填:live 投遞的是用戶真打的那句,把「模型已切換」的行 id 當成
    # 它的 dedup_key 會讓鏡像後來把真的那條又投一遍。
    return [(rid, role) for rid, role, kind, _m in rows if role != "user" or _display_role(kind) == "user"]


async def turn_rows(sid: str, since: int) -> list:
    return await asyncio.to_thread(_retry_locked, _turn_rows_sync, sid, since)


async def tail_session(sid: str, since_id: int) -> tuple:
    return await asyncio.to_thread(_retry_locked, _tail_session_sync, sid, since_id)
