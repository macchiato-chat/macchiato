#!/usr/bin/env python3
"""
Shared backfill helpers — enumerate importable Hermes history (design.md §11).

Used by connector.py (live feature: import_available + import_batch over Link B).

Source of truth: **~/.hermes/state.db** (SQLite). Hermes stopped writing
`~/.hermes/sessions/*.jsonl` around 2026-05-21 and moved to state.db, so the old
.jsonl path MISSES the recent month (incl. the bulk of Discord/Telegram chats).
state.db has the complete `sessions` + `messages` tables. We read it read-only
(Hermes writes it live; SQLite WAL allows concurrent readers) on a worker thread.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sqlite3
import time

STATE_DB = os.path.expanduser("~/.hermes/state.db")
STALE_TURN_S = float(os.environ.get("MACCHIATO_STALE_TURN_S", "600"))  # 末行 tool_calls 久未結算→視為崩、強制結算

# Sources that are automation, not human↔agent conversations.
# "tui" = 連接器自己經 tui_gateway 驅動的會話（Macchiato 新建對話）→ 已由 live/drive 路徑投遞，
# 絕不能再鏡像（否則 server 用 state.db 的運行時 id 另建一條 → 同一對話翻倍；同事實測的 bug）。
# 用戶本機終端的 tui 會話也一併不鏡像（終端是本地、非外部消息平台）。結構化識別，取代舊的
# _rev/_fwd id 映射跳過——後者在 Hermes 0.18+ 失效：create_session 返回的 gateway 句柄 ≠ state.db
# 會話 id，mirror 看的是後者，永遠匹配不上。
SKIP_SOURCES = {"cron", "scheduled", "system", "tui"}
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


def _connect() -> sqlite3.Connection:
    return sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True)


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


def _derive_title(con: sqlite3.Connection, sid: str) -> str:
    row = con.execute(
        "select content from messages where session_id=? and role='user' and content!='' "
        "order by id limit 1",
        (sid,),
    ).fetchone()
    if row and row[0]:
        t = " ".join(_strip_sender_tag(str(row[0])).split())
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
    out = []
    for role, content, reasoning, tool_calls, ts in con.execute(
        "select role, content, reasoning, tool_calls, timestamp from messages "
        "where session_id=? and role in ('user','assistant') order by id",
        (sid,),
    ):
        content = content or ""
        if role == "user":
            content = _strip_sender_tag(content)
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


def _enumerate_sync() -> list:
    con = _connect()
    try:
        out = []
        for sid, source, title, started_at, _mc, archived in _kept_sessions(con):
            msgs = _read_messages(con, sid)
            if not msgs:
                continue
            out.append(
                {
                    "hermesSessionId": sid,
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
async def count_importable(*_args) -> int:
    return await asyncio.to_thread(_count_sync)


async def enumerate_importable(*_args) -> list:
    return await asyncio.to_thread(_enumerate_sync)


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


def _changed_sessions_sync() -> list:
    """每個會話的 (sid, source, title, archived, max_msg_id)；caller 用各自水位線比對。"""
    con = _connect()
    try:
        return con.execute(
            "select s.id, s.source, s.title, s.archived, max(m.id) "
            "from sessions s join messages m on m.session_id = s.id "
            "where m.role in ('user','assistant','tool') group by s.id"
        ).fetchall()
    finally:
        con.close()


def _tail_session_sync(sid: str, since_id: int) -> tuple:
    """新增（raw id > since_id）的**已結算**消息 + 新水位線。折疊 tool 行；尾部 in-flight
    （最後一行是仍在調工具的 assistant）暫不鏡像、不推進水位線 → 下輪自愈。"""
    con = _connect()
    try:
        rows = list(con.execute(
            "select id, role, content, reasoning, tool_calls, tool_call_id, timestamp, finish_reason "
            "from messages where session_id=? and role in ('user','assistant','tool') order by id",
            (sid,),
        ))
        if not rows:
            return [], since_id
        tool_res, tool_rid = {}, {}
        for rid, role, content, _r, _tc, tcid, _ts, _fr in rows:
            if role == "tool" and tcid:
                tool_res[tcid] = content or ""
                tool_rid[tcid] = rid
        folded = []  # (msg, cover_id)：cover = 該折疊消息覆蓋的最大 raw id（含其 tool 結果行）
        for rid, role, content, reasoning, tc, tcid, ts, fr in rows:
            content = content or ""
            if role == "user":
                c = _strip_sender_tag(content)
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
        last = rows[-1]
        # in-flight：末行是仍在調工具的 assistant。但若它已很舊（>STALE_TURN_S，疑似 agent
        # 中途崩、那條 tool_calls 永無結果）則強制結算，避免該會話鏡像永久卡死（修 C）。
        inflight = last[1] == "assistant" and last[7] == "tool_calls"
        if inflight:
            try:
                if time.time() - float(last[6]) > STALE_TURN_S:
                    inflight = False
            except (TypeError, ValueError):
                pass
        settled = folded[:-1] if (inflight and folded and folded[-1][0]["role"] == "agent") else folded
        new_msgs = [m for (m, cover) in settled if cover > since_id]
        new_wm = since_id
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
    return await asyncio.to_thread(_session_snapshot_sync, sid)


async def current_max_id() -> int:
    return await asyncio.to_thread(_current_max_id_sync)


async def changed_sessions() -> list:
    return await asyncio.to_thread(_changed_sessions_sync)


async def tail_session(sid: str, since_id: int) -> tuple:
    return await asyncio.to_thread(_tail_session_sync, sid, since_id)
