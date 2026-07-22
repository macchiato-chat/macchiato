#!/usr/bin/env python3
"""
Macchiato Hermes connector — bridges real Hermes (via GatewayClient / tui_gateway)
to the App Server over Link B (the server's `/connector` WSS).

Link B contract (services/server/src/linkB + packages/protocol/src/link.ts):
  - open WSS → send  hello {t, connectorToken, agentLinkId, proto} → await {t:"ready"}
  - server → connector:  {t:"tui", agentLinkId, sessionId, frame}   (frame = tui REQUEST)
  - connector → server:  {t:"tui", agentLinkId, sessionId, frame}   (frame = tui EVENT)
  - {t:"ping"} → {t:"pong"}

Session-id translation (the connector's job, per outbound.ts):
  The server uses its OWN session ids (chat_sessions.hermes_session_id); real Hermes
  assigns its own. We lazily create a real Hermes session per server session id and
  map both ways, rewriting `session_id` on the way through.

Run (needs `websockets`, present in the Hermes venv):
  MACCHIATO_CONNECTOR_TOKEN=... MACCHIATO_AGENT_LINK_ID=... \
  ~/.local/share/pipx/venvs/hermes-agent/bin/python services/hermes-connector/connector.py
Env:
  MACCHIATO_SERVER_URL      default ws://localhost:8080/connector
  MACCHIATO_CONNECTOR_TOKEN required
  MACCHIATO_AGENT_LINK_ID   required
  HERMES_PYTHON             gateway python (default: hermes-agent venv)
"""

from __future__ import annotations

import asyncio
import base64
import importlib
import json
import mimetypes
import os
import re
import http.client
import ipaddress
import socket
import ssl
import subprocess
import sys
import time
import traceback
from collections import deque
from urllib.parse import urlparse

import websockets

import hashlib

from gateway_client import GatewayClient, GatewayDied, GatewayError
from e2e_keys import E2EKeyStore
from backfill import (
    count_importable,
    enumerate_importable,
    changed_sessions,
    sessions_meta,
    tail_session,
    turn_rows,
    current_max_id,
    keepable,
    cron_feed_target,
    session_snapshot,
)

LINK_B_PROTO = 3  # 對齊 server（packages/protocol：B=3，附件雙向那版；嚴格校驗）
# §update 連接器發布版本:對齊 packages/protocol CONNECTOR_VERSION。⚠️ 發版必須**五處同步 bump**:
# 四連接器常量(cc/codex/openclaw 各自 src/index.ts + 這裡)+ protocol link.ts 全局。全局是 server
# 判 updateAvailable 的標尺——bump 全局漏任何一家=該家 app 永亮「更新」(本機與公開用戶一起亮,
# 重啟無用;2026-07-20 實踩);全局上生產後應儘快 sync-public 發版閉環。
CONNECTOR_VERSION = "1.5.36"
# #279 E2E prompt 解密失敗的用戶可見回執(僅提示語,零內容洩漏;四連接器同文案)。
E2E_DECRYPT_FAIL_WARNING = "無法解密這條消息(設備與連接器的加密密鑰可能失步)——請重試,或重新關閉再開啟本會話的端到端加密。"
# 自更新拉取的安裝腳本（拉最新版 + 重啟服務，配對保留）。可經 env 覆蓋（測試/私有分發）。
INSTALL_URL = os.environ.get(
    "MACCHIATO_INSTALL_URL",
    "https://raw.githubusercontent.com/macchiato-chat/macchiato/main/install.sh",
)
IMPORT_BATCH = 20
# §15 全渠道持續鏡像（tail state.db）——默認常開;#308 MACCHIATO_MIRROR=off 可停(見 MIRROR_OFF)。
MIRROR_POLL_S = float(os.environ.get("MACCHIATO_MIRROR_POLL_S", "2"))  # 輪詢間隔（小=更即時、多步回合更增量）
# #308 MACCHIATO_MIRROR=off:停鏡像輪詢+首裝自動導入(終端側活動不進 app)。⚠️ 只停這兩樣——
# driven 會話路徑/dedup 衛生照常;_mirror_last_run 恆 None → 看門狗與 server staleness 天然跳過。
MIRROR_OFF = os.environ.get("MACCHIATO_MIRROR", "").lower() in ("off", "0", "false", "no")
MIRROR_STATE = os.path.expanduser("~/.macchiato/mirror.json")  # 鏡像水位線持久化
PROJ_MEM_MAX = 256 * 1024  # #227 AGENTS.md 上限
PROJ_SHIM = "@AGENTS.md\n"  # #227 CLAUDE.md 墊片


def _projects_reg_path() -> str:
    return os.environ.get("MACCHIATO_HERMES_PROJECTS") or os.path.expanduser("~/.macchiato/hermes-projects.json")


def _mem_hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]
MIRROR_PRUNE_S = float(os.environ.get("MACCHIATO_MIRROR_PRUNE_S", str(30 * 24 * 3600)))  # #9 水位線閒置多久可裁
# 自驅會話 id 映射持久化：server sid（ULID）→ state.db 會話 id（gateway session_key）。
# Hermes 0.18+ 的 create_session 返回 stored_session_id = state.db 行 id ≠ 運行時句柄；
# 沒有這張表，自驅會話的 E2E 加密鏡像投遞 / 重啟後帶上下文續聊 / 歸檔回寫都對不上號。
SESSIONS_MAP = os.path.expanduser("~/.macchiato/sessions.json")
ATTACH_DIR = os.path.expanduser("~/.macchiato/attachments")  # 入站附件落地（gateway 同機可讀）
HEALTH_FILE = os.path.expanduser("~/.macchiato/health.json")  # 本地健康快照（可本機 inspect）
PUSH_SOCK = os.path.expanduser(os.environ.get("MACCHIATO_PUSH_SOCK", "~/.macchiato/push.sock"))  # §17 主動投遞：Hermes macchiato 插件 → 連接器
HEALTH_INTERVAL_S = float(os.environ.get("MACCHIATO_HEALTH_S", "30"))
ATTACH_TTL_S = float(os.environ.get("MACCHIATO_ATTACH_TTL_S", str(6 * 3600)))  # 入站附件保留 6h 後 GC
MIRROR_STUCK_S = float(os.environ.get("MACCHIATO_MIRROR_STUCK_S", "60"))  # 鏡像輪詢時延超此→判卡死、重啟


def _sanitize_filename(name: str) -> str:
    name = os.path.basename(name or "").strip()
    name = re.sub(r"[^\w.\-]+", "_", name)
    return name[:120] or "attachment"


DOWNLOAD_MAX = 100 * 1024 * 1024  # 入站附件下載封頂（100MB），超出即中止（防無界寫盤）
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _validate_download_url(url: str) -> None:
    """SSRF / 本地文件防護（審計 #12）：server 下發的 url 直喂 urllib 會被 file:// 讀本機密鑰、
    或指向內網/雲元數據做 SSRF（萬一 server 被攻破 / 明文 MITM）。只允許 https（或 http+localhost 的
    dev-disk 服務）；拒 file/ftp/data/gopher；https 目標解析後不得落在私網/環回/link-local/保留段。"""
    p = urlparse(url)
    host = (p.hostname or "").lower()
    if p.scheme == "http" and host in _LOCAL_HOSTS:
        return  # 本地 dev-disk 服務（生產走 https）
    if p.scheme != "https":
        raise ValueError(f"不允許的 url scheme：{p.scheme!r}（只允許 https）")
    if not host:
        raise ValueError("url 缺主機名")
    try:
        infos = socket.getaddrinfo(host, p.port or 443, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise ValueError(f"解析主機失敗：{exc}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ValueError(f"目標 IP {ip} 在私網/環回/保留範圍（防 SSRF）")


def _open_validated_download(url: str, timeout: float = 30.0):
    """#249 pin-IP 下載:解析→校驗→**連校驗過的那個 IP**(SNI/cert 仍用 hostname)→GET。此前
    _validate_download_url 用 getaddrinfo 校驗、urlopen 卻獨立再解析一次(TOCTOU:兩次解析間
    DNS-rebinding 換內網 IP 可繞過),且 urlopen 默認**跟隨 302**、可重定向到內網。改為單次解析、
    直接連校驗過的 IP、不跟隨重定向(3xx 也拒)。返回 http.client.HTTPResponse(caller 讀+關)。"""
    p = urlparse(url)
    host = (p.hostname or "").lower()
    path = p.path or "/"
    if p.query:
        path += "?" + p.query
    headers = {"User-Agent": "macchiato-connector"}
    if p.scheme == "http" and host in _LOCAL_HOSTS:
        conn = http.client.HTTPConnection(host, p.port or 80, timeout=timeout)
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
    else:
        if p.scheme != "https":
            raise ValueError(f"不允許的 scheme：{p.scheme!r}（只允許 https）")
        if not host:
            raise ValueError("url 缺主機名")
        port = p.port or 443
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        ip = None
        for info in infos:
            cand = ipaddress.ip_address(info[4][0])
            if cand.is_private or cand.is_loopback or cand.is_link_local or cand.is_reserved or cand.is_multicast:
                raise ValueError(f"目標 IP {cand} 在私網/環回/保留範圍（防 SSRF DNS-rebinding）")
            if ip is None:
                ip = info[4][0]
        if ip is None:
            raise ValueError("解析無可用地址")
        raw = socket.create_connection((ip, port), timeout=timeout)  # 連校驗過的 IP（pin）
        try:
            sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)  # SNI/cert 用 hostname
        except Exception:
            raw.close()
            raise
        conn = http.client.HTTPSConnection(host, port, timeout=timeout)
        conn.sock = sock  # 注入已連好的 socket → request 不再 connect()、不再重解析
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
    if resp.status >= 300:  # 不跟隨重定向:3xx 也拒(此前 urlopen 會跟 302 跳內網)
        resp.close()
        raise ValueError(f"下載失敗/拒重定向 HTTP {resp.status}")
    return resp


def _materialize_attachment(ref: dict) -> str:
    """下載 presigned GET url 到本地文件（連接器與 gateway 同機，落盤即可讓 gateway 讀）。"""
    _validate_download_url(str(ref.get("url") or ""))  # 審計 #12：下載前早拒（file:// / 字面私網）
    name = _sanitize_filename(ref.get("name") or "")
    if "." not in name:
        ext = mimetypes.guess_extension((ref.get("mime") or "").split(";")[0].strip()) or ""
        name += ext
    d = os.path.join(ATTACH_DIR, re.sub(r"[^\w\-]+", "_", str(ref.get("id") or "att")))
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name)
    written = 0
    with _open_validated_download(str(ref["url"])) as r, open(path, "wb") as f:  # #249 pin-IP + 拒重定向
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            written += len(chunk)
            if written > DOWNLOAD_MAX:
                raise ValueError(f"下載超過上限 {DOWNLOAD_MAX} 字節，已中止")
            f.write(chunk)
    return path


_STT_AVAILABLE = None  # 惰性探測緩存（進程生命週期內不變）


def _stt_available() -> bool:
    """#89 語音轉錄能力探測（health 上報 `stt` 位，server 據此路由雲端 STT 回退鏈）。
    voice_mode 可 import 即視為有——provider 未配好時 transcribe 運行期報錯，
    server 收到失敗回執後仍會反應式回退（見 _transcribe_attachment 的 error 路徑）。"""
    global _STT_AVAILABLE
    if _STT_AVAILABLE is None:
        try:
            from tools.voice_mode import transcribe_recording  # noqa: F401

            _STT_AVAILABLE = True
        except Exception:
            _STT_AVAILABLE = False
    return _STT_AVAILABLE


def _transcribe_attachment(ref: dict) -> dict:
    """語音輸入：下載 audio 附件 → 用 Hermes 自帶 STT（tools.voice_mode）本地轉錄。
    返回 {"text": <轉錄文字>}；不可用/失敗/空 → {"text": "", "error": <機器可讀原因>}。
    阻塞（下載 + Whisper），務必在 asyncio.to_thread 裡跑。連接器與 Hermes 同 venv，
    `tools` 是 editable 安裝、任意 CWD 可 import；STT provider 需在 ~/.hermes/config.yaml 配好
    （local faster-whisper / openai / groq / mistral），否則 transcribe_recording 報錯→這裡降級。"""
    try:
        path = _materialize_attachment(ref)
    except Exception as exc:
        return {"text": "", "error": f"download_failed: {exc!r}"}
    try:
        from tools.voice_mode import transcribe_recording
    except Exception as exc:
        return {"text": "", "error": f"stt_unavailable: {exc!r}"}
    try:
        result = transcribe_recording(path)
    except Exception as exc:
        return {"text": "", "error": f"stt_failed: {exc!r}"}
    if not result.get("success"):
        return {"text": "", "error": str(result.get("error") or "stt_failed")}
    return {"text": (result.get("transcript") or "").strip()}


MEDIA_MAX = 12 * 1024 * 1024  # 出站附件 base64 內聯上限（12MB），超出跳過


def _extract_media_files(text: str) -> list:
    """復用 Hermes 平台適配器的 MEDIA:/裸路徑解析（與 Discord/Telegram 投遞同一套）。"""
    from gateway.platforms.base import BasePlatformAdapter as B

    media, cleaned = B.extract_media(text)
    media = B.filter_media_delivery_paths(media)  # [(path, is_voice)]，校驗存在
    local, _ = B.extract_local_files(cleaned)
    local = B.filter_local_delivery_paths(local)
    out, seen = [], set()
    for path, _v in list(media) + [(p, False) for p in local]:
        if path not in seen:
            seen.add(path)
            out.append(path)
    return out


def _read_media_file(path: str) -> dict | None:
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    if size <= 0 or size > MEDIA_MAX:
        if size > MEDIA_MAX:
            print(f"[media too big, skip] {path} {size}B", file=sys.stderr)
        return None
    with open(path, "rb") as f:
        data = f.read()
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return {
        "kind": "image" if mime.startswith("image/") else "document",
        "name": os.path.basename(path),
        "mime": mime,
        "size": size,
        "data_b64": base64.b64encode(data).decode("ascii"),
    }


def _gc_attachments() -> int:
    """刪除 ATTACH_DIR 下超過 ATTACH_TTL_S 的入站附件（prompt 早已消費，無需長留）。"""
    now = time.time()
    removed = 0
    try:
        for root, _dirs, files in os.walk(ATTACH_DIR, topdown=False):
            for name in files:
                p = os.path.join(root, name)
                try:
                    if now - os.path.getmtime(p) > ATTACH_TTL_S:
                        os.remove(p)
                        removed += 1
                except OSError:
                    pass
            if root != ATTACH_DIR:
                try:
                    os.rmdir(root)  # 只刪空目錄
                except OSError:
                    pass
    except FileNotFoundError:
        pass
    return removed


def _check_hermes_compat() -> dict:
    """探測連接器依賴的 Hermes 內部 API + 版本（Hermes 自動更新可能改動內部，需自檢）。
    返回 {hermes_version, checks:{name: True|"FAIL: ..."}}。"""
    checks: dict = {}
    ver = None
    try:
        from importlib.metadata import version as _ver

        ver = _ver("hermes-agent")
    except Exception as exc:
        checks["hermes_version"] = f"FAIL: {exc!r}"

    def _probe(name, fn):
        try:
            fn()
            checks[name] = True
        except Exception as exc:
            checks[name] = f"FAIL: {exc!r}"

    def _sdb():
        m = importlib.import_module("hermes_state")
        for a in ("set_session_archived", "resolve_session_id"):
            assert hasattr(m.SessionDB, a), a

    def _base():
        b = importlib.import_module("gateway.platforms.base").BasePlatformAdapter
        for a in ("extract_media", "extract_local_files", "filter_media_delivery_paths"):
            assert hasattr(b, a), a

    _probe("hermes_state.SessionDB", _sdb)  # session.archive 回寫
    _probe("gateway.platforms.base", _base)  # 出站附件 extract_media
    def _tui():
        import importlib.util as _u

        # 只查模塊存在、不 import（tui_gateway.entry import 時會註冊 signal，工作線程里會炸）。
        assert _u.find_spec("tui_gateway.entry") is not None

    _probe("tui_gateway.entry", _tui)  # gateway 主幹
    return {"hermes_version": ver, "checks": checks}


def _smoke_parse_state_db() -> str | None:
    """#112 解析冒煙(對齊 CC smokeParseLatest):按鏡像/導入同款 schema 讀最新一條 assistant 消息、
    跑同款 tool_calls 解析——Hermes 升級改 state.db schema / tool_calls 格式時,在靜默丟消息之前
    把降級亮出來。無庫/空庫不判失敗(新機器)。返回 None=通過,str=降級原因。"""
    try:
        import backfill as _bf

        if not os.path.exists(_bf.STATE_DB):
            return None
        con = _bf._connect()
        try:
            # schema 漂移(列改名/表改名)→ OperationalError;tool_calls 格式漂移 → 解析拋錯
            row = con.execute(
                "select role, content, reasoning, tool_calls from messages "
                "where role='assistant' order by id desc limit 1"
            ).fetchone()
            if row is not None:
                _bf._parse_tool_calls(row[3], {})
        finally:
            con.close()
        return None
    except Exception as exc:
        return f"state.db 解析冒煙失敗(schema/格式漂移?): {exc!r}"


class Connector:
    def __init__(
        self,
        server_url: str,
        connector_token: str,
        agent_link_id: str,
        *,
        hermes_python: str | None = None,
    ) -> None:
        self.server_url = server_url
        self.connector_token = connector_token
        self.agent_link_id = agent_link_id
        self.hermes_python = hermes_python

        self.ws = None
        self.gw: GatewayClient | None = None
        self._fwd: dict[str, str] = {}  # server session id -> real hermes session id
        self._cwds: dict[str, str] = {}  # #227 server sid -> 會話工作目錄(建會話時傳給 gateway)
        self._rev: dict[str, str] = {}  # real hermes session id -> server session id
        self._pending_interrupt: set[str] = set()  # 回合映射建立前到達的 session.interrupt：別丟，等回合起步即取消
        self._titled: set[str] = set()  # #94：已自動生成過標題的 server_sid（防會話內重複）
        # #302:live 在途回合(message.start 已轉發、complete 未到)的 server_sid。gateway 死亡時
        # 這些回合永收不到終態 → server 卡 streaming、用戶氣泡永轉圈;重啟鉤子據此定稿 error。
        self._live_inflight: set[str] = set()
        self._prompt_retried: set = set()  # #4：已重投過的 (sid, text 哈希)——每條 prompt 最多重投一次，防雙發
        self._retry_tasks: dict = {}  # #4/#5：sid → 在途重投任務。用戶中斷時取消之——已停的 prompt 不許復活
        # #148:per-session 串行任務鏈(sid → 鏈尾 task)。prompt.submit 的慢工作(resume 往返/
        # 附件下載 100MB/STT)不再內聯 await 在讀循環裡——某會話的一條慢消息此前會 head-of-line
        # 阻塞**所有**會話的派發。同會話仍串行(鏈式 await 前任),跨會話並發。
        self._session_chains: dict = {}
        # #10:累計計數(進程生命週期)。健康上報帶出——一次性的丟/重複/重投靠狀態快照看不見。
        self._counters: dict = {}
        # #13:server_sid → prompt.submit 時的全庫 max 行 id。回合結束後,> 它的行即本回合
        # 寫進 state.db 的行——其 id 回填給 server 作 live 消息的 dedup_key(與鏡像 srcId 同鍵)。
        self._turn_floor: dict = {}
        self._sdb = None  # 懶加載的 Hermes SessionDB（session.archive 用，寫 state.db.archived）
        self._mirror_task = None  # §15 持續鏡像 tailer 任務
        self._health_task = None  # 健康上報任務
        self._push_server = None  # §17 主動投遞：本地 unix socket（Hermes macchiato 插件 → Link B）
        self._push_seq = 0
        self._started_at = time.time()
        self._linkb_state = "init"
        self._mirror_last_run = None
        self._last_error = None
        self._compat: dict = {}
        self._smoke_err: str | None = None  # #112 解析冒煙結果(健康循環定期刷新)
        self._mirror_st = None  # 鏡像水位線狀態（nack 回退也要訪問）
        self._fresh_install = False  # #154 首裝標記(run() 起步採樣;首裝 → ready 後自動全量導入)
        self._projects: dict = {}  # #227 serverPath → canonical(本地註冊表,mem 操作硬校驗)
        self._proj_last_hash: dict = {}  # #227 canon → AGENTS.md hash(回合末比對)
        self._projects_load()
        self._mirror_batch_id = 0
        self._mirror_rewind = deque(maxlen=64)  # (batchId, {sid: 舊floor})，供 nack 回退
        self._out_pending: deque = deque(maxlen=500)  # 斷線期間出站幀緩衝(ready 後補發;有界丟最舊)
        self._linkb_ready = False  # #251 收到 t:"ready" 才置真:handshaking 窗口不直發未認證幀、走緩衝
        self._on_fatal = lambda: sys.exit(1)  # #246 auth_error 終端態 → 退出交 supervisor(測試可覆蓋)
        self._e2e = E2EKeyStore()  # §19 per-session E2E 密鑰管理（持 K_S、封裝給設備、加解密內容）
        self._mirror_lock = None  # 鏡像輪詢 ↔ E2E 歷史回灌互斥（防舊 floor 追加與整段替換競態）
        # 自驅會話持久映射（server sid ↔ state.db id）。跨進程/gateway 重啟保留——E2E 鏡像投遞、
        # resume 帶上下文、歸檔回寫都靠它。
        self._stored: dict[str, str] = self._load_stored()  # server sid -> state.db id
        self._stored_rev: dict[str, str] = {v: k for k, v in self._stored.items()}

    async def run(self) -> None:
        loop = asyncio.get_running_loop()

        def on_event(params: dict) -> None:
            # agent → you: translate real session id back to the server's, then forward.
            real_sid = params.get("session_id")
            server_sid = self._rev.get(real_sid, real_sid)
            if self._e2e.is_e2e(server_sid):
                # §19 E2E:內容事件(message.*/tool.*)走加密鏡像抑制;但 #240 交互事件不能一起黑洞——
                # approval.request 加密後放行(否則 agent 要審批用戶永遠看不到、回合卡死),媒體放行
                # (照 e2e.md 既定邊界:附件不 E2E、存 server 可讀桶)。clarify/secret 的雙向加密走 follow-up。
                etype = params.get("type")
                fwd = self._e2e_live_frame(server_sid, etype, params.get("payload") or {})
                if fwd is not None:
                    loop.create_task(self._to_server(server_sid, fwd))
                if etype == "message.complete":
                    text = (params.get("payload") or {}).get("text") or ""
                    if text:
                        loop.create_task(self._emit_media_from_text(server_sid, text))  # 媒體放行
                    self._projects_check_turn_end()  # #227 回合末惰性版本化
                return
            frame = {
                "jsonrpc": "2.0",
                "method": "event",
                "params": {**params, "session_id": server_sid},
            }
            loop.create_task(self._to_server(server_sid, frame))
            # #302:追蹤 live 在途回合(start→complete),gateway 死亡時據此定稿 error。
            if params.get("type") == "message.start":
                self._live_inflight.add(server_sid)
            elif params.get("type") == "message.complete":
                self._live_inflight.discard(server_sid)
            # 出站附件：message.complete 正文裡 MEDIA:/裸路徑標的文件 → media.attach。
            if params.get("type") == "message.complete":
                text = (params.get("payload") or {}).get("text") or ""
                if text:
                    loop.create_task(self._emit_media_from_text(server_sid, text))
                # #13:回合結束 → 回填本回合消息的源身份(state.db 行 id → live dedup_key)
                if server_sid in self._turn_floor:
                    loop.create_task(self._backfill_srcids(server_sid))
                self._projects_check_turn_end()  # #227 agent 可能在本回合改了備案目錄的 AGENTS.md

        self.gw = GatewayClient(
            on_event=on_event,
            on_restart=self._on_gateway_restart,
            hermes_python=self.hermes_python,
        )
        await self.gw.start()
        print("· hermes gateway up")

        self._compat = await asyncio.to_thread(_check_hermes_compat)
        self._log_compat()

        # #154 首裝採樣:水位線文件(含 .bak)從未存在 = 這台機器第一次跑 → ready 後自動全量導入。
        # 必須在鏡像循環建基線**之前**採樣,否則首輪保存後就分不出新舊安裝了。
        self._fresh_install = not (os.path.exists(MIRROR_STATE) or os.path.exists(MIRROR_STATE + ".bak"))
        if MIRROR_OFF:
            # ⚠️ 回歸契約:scripts/localchain/scenarios-mirror-off.mjs 斷言此串,改文案需同步
            print("· Mirror disabled (MACCHIATO_MIRROR=off) — terminal sessions stay out of the app; app-driven sessions unaffected")
        else:
            self._mirror_task = asyncio.create_task(self._mirror_loop())
            print(f"· 持續鏡像已啟（輪詢 {MIRROR_POLL_S}s）")
        self._health_task = asyncio.create_task(self._health_loop())
        await self._start_push_socket()

        hello = json.dumps(
            {
                "t": "hello",
                "connectorToken": self.connector_token,
                "agentLinkId": self.agent_link_id,
                "proto": LINK_B_PROTO,
            }
        )
        # 保活心跳 + 自動重連：Fly 邊緣會掐閒置 WS；gateway 與 session 映射跨重連保留。
        backoff = 1
        try:
            while True:
                try:
                    async with websockets.connect(
                        # #247 ping_timeout 此前為 None——websockets 的 liveness 被關掉,server
                        # 半開(進程亡但 TCP 未 FIN)時永遠檢測不到、幀發進黑洞。改有限值:每 20s WS-ping,
                        # 無 pong 超時即斷 → 外層重連。取 45s(寬容家用上行推大 import 批時 pong 遲到,
                        # 又能在一分鐘內揪出死連接);env 可調。
                        self.server_url,
                        ping_interval=20,
                        ping_timeout=float(os.environ.get("MACCHIATO_LINKB_PING_TIMEOUT", "45")),
                        close_timeout=10,
                    ) as ws:
                        self.ws = ws
                        self._linkb_ready = False  # #251 新連接:ready 前不直發(見 _send)
                        self._linkb_state = "handshaking"
                        await ws.send(hello)
                        async for raw in ws:
                            backoff = 1  # 收到幀 = 健康，重置退避
                            # #251:單條幀分支異常(如 e2e_wrap_request payload 畸形)此前會炸穿主循環、
                            # _out_pending 全丟。這裡吞掉非斷線異常,主循環照跑;斷線仍上拋外層重連。
                            try:
                                await self._on_server_msg(raw)
                            except (websockets.exceptions.ConnectionClosed, OSError):
                                raise
                            except Exception as exc:
                                self._count("serverMsgErrors")
                                print(f"[_on_server_msg 分支異常吞掉,不崩主循環] {exc!r}", file=sys.stderr)
                except (websockets.exceptions.ConnectionClosed, OSError) as exc:
                    print(f"· link B 斷開（{type(exc).__name__}），{backoff}s 後重連…", file=sys.stderr)
                self.ws = None
                self._linkb_ready = False
                self._linkb_state = "disconnected"
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
        finally:
            for tk in (self._mirror_task, self._health_task):
                if tk is not None:
                    tk.cancel()
            if self._push_server is not None:
                self._push_server.close()
                try:
                    os.unlink(PUSH_SOCK)
                except OSError:
                    pass
            await self.gw.close()

    async def _to_server(self, server_sid: str, frame: dict) -> None:
        # 統一走 _send:斷線期間緩衝、ready 後補發(live 回合尾巴不再因 server 部署而丟)
        await self._send(
            {"t": "tui", "agentLinkId": self.agent_link_id, "sessionId": server_sid, "frame": frame}
        )

    def _on_gateway_restart(self) -> None:
        # #302 gateway 死亡:在途 live 回合永收不到 message.complete → server 卡 streaming、
        # 用戶氣泡永轉圈。對齊 CC 語義:立即定稿 error(可見可重試);內容若已落 state.db,
        # 鏡像/對賬路徑會補進歷史。E2E 會話 live 被抑制、不進 _live_inflight,天然不涉及。
        if self._live_inflight:
            try:
                loop = asyncio.get_running_loop()
                for sid in list(self._live_inflight):
                    frame = {
                        "jsonrpc": "2.0",
                        "method": "event",
                        "params": {
                            "type": "message.complete",
                            "session_id": sid,
                            "payload": {"text": "", "status": "error", "warning": "Hermes gateway 重啟,本回合中止——請重試"},
                        },
                    }
                    loop.create_task(self._to_server(sid, frame))
                    print(f"[#302] gateway 死亡 → 在途回合定稿 error({sid})", file=sys.stderr)
            except RuntimeError:
                pass  # 無運行中事件循環(理論不達:本鉤子由 supervise 協程調用)
            self._live_inflight.clear()
        # gateway 重啟後，舊 session 映射失效（新 gateway 無這些活躍會話）→ 清空，
        # 下次 prompt 重新 resume（帶上下文）/ create。
        # 自驅會話的 live 消息已投遞過 → 重啟後推進其鏡像水位線、免得重發。需含 _fwd 鍵
        # （持久化 hermesSessionId，鏡像看到的就是它）；_rev 鍵是運行時 id、非 state.db 會話，
        # _advance_mirror_driven 會自動忽略（不在 changed_sessions 里）。
        # §19 E2E 例外：E2E 自驅會話的內容靠加密鏡像投遞（live 被 on_event 抑制）→ 絕不能推進其
        # 水位線，否則重啟前**尚未鏡像**的 E2E 消息會被永久跳過（丟失）。按持久化 id（K_S 的鍵）判 E2E，
        # 把該會話的運行時 id 與持久化 id 都排除出 driven。
        e2e_skip = set()
        for real_id, server_sid in self._rev.items():
            if self._e2e.is_e2e(server_sid):
                e2e_skip.add(real_id)
                e2e_skip.add(server_sid)
        driven = [s for s in (list(self._rev.keys()) + list(self._fwd.keys())) if s not in e2e_skip]
        # #203:清映射**前**捕獲每會話的 srcId 回填 floor(_turn_floor 按 server_sid 鍵;鏡像水位線按
        # state.db sid 鍵)。floor = 最後一次成功回填 dedup_key 的行 → 快進絕不能越過它(floor 之後的行
        # 可能已落庫但尚未 live 投遞/尚未回填——重啟瞬間的 in-flight 回合,推過去 = 靜默永久丟)。
        floors: dict = {}
        _tf = getattr(self, "_turn_floor", {})
        _stored = getattr(self, "_stored", {})
        for server_sid in list(self._fwd.keys()):
            fl = _tf.get(server_sid)
            if fl is not None:
                floors[_stored.get(server_sid, server_sid)] = fl
        self._fwd.clear()
        self._rev.clear()
        self._pending_interrupt.clear()  # 重啟後舊回合已死，早到的 pending 中斷作廢
        self._count("gatewayRestarts")  # #10
        print("· gateway 重啟，已清空 session 映射")
        # 修 A：_rev 一清，鏡像就不再跳過這些會話 → 會把 live 已投遞的消息重發成重複。
        # 把它們的鏡像水位線推到當前 max（重啟後不重發舊消息；之後的 Discord 續聊仍會鏡像）。
        if driven:
            asyncio.create_task(self._advance_mirror_driven(driven, floors))
        asyncio.create_task(self._report_commands())  # #199 catalog 可能隨升級變 → 重發清單

    async def _advance_mirror_driven(self, sids: list, floors: dict | None = None) -> None:
        """#203:快進上限 = min(當前 max, 該會話 srcId 回填 floor)。floor 之前的行必然「已 live 投遞
        且已回填 dedup_key」——鏡像若重發撞 (session,dedup_key) 唯一索引被吃掉,不雙投;floor 之後的行
        (重啟瞬間 in-flight / 尚未回填)留給鏡像照常 tail 補投——漏的救回來,不再靜默丟。無 floor
        (本進程沒完成過回合)→ 不推:此前的行都在上個進程的回合末回填過,鏡像重發同樣被 dedup 吃掉。
        (E2E 會話在調用方已排除——它們的水位線永不推,原有守衛不變。)"""
        if self._mirror_st is None:
            return
        wm = self._mirror_st["sessions"]
        floors = floors or {}
        try:
            maxes = {r[0]: r[4] for r in await changed_sessions()}
        except Exception as exc:
            print(f"[advance_mirror_driven failed] {exc!r}", file=sys.stderr)
            return
        changed = False
        for sid in sids:
            mx = maxes.get(sid)
            fl = floors.get(sid)
            if mx is None or fl is None:
                continue  # 非 state.db 會話 / 無回填 floor → 不推(鏡像重發靠 dedup 兜)
            target = min(mx, fl)
            if target > wm.get(sid, 0):
                wm[sid] = target
                changed = True
        if changed:
            self._save_mirror_state(self._mirror_st)
            print("· 鏡像水位線推進(≤srcId floor)——重啟不重發、in-flight 行留給鏡像補投", file=sys.stderr)

    def _session_db(self):
        # 懶加載 Hermes 的 SessionDB（連接器跑在 hermes-agent venv 內，同一份 hermes_state）。
        # 用它官方的 set_session_archived（會連帶處理壓縮 lineage，比裸 UPDATE 穩）。
        if self._sdb is None:
            from hermes_state import SessionDB

            self._sdb = SessionDB()  # 默認 ~/.hermes/state.db；check_same_thread=False，可跨線程
        return self._sdb

    async def _set_hermes_title(self, server_sid: str, title: str) -> None:
        # #161 手動改名回寫(archive 同款路徑):自驅會話用持久映射的 state.db id;導入會話用原值。
        real = self._stored.get(server_sid) or self._fwd.get(server_sid, server_sid)

        def _do():
            db = self._session_db()
            sid = db.resolve_session_id(real) or real
            return sid, db.set_session_title(sid, title)

        sid, ok = await asyncio.to_thread(_do)
        print(f"· session.rename {sid} → {title!r}({'ok' if ok else 'no-op'})")

    async def _set_hermes_archived(self, server_sid: str, archived: bool) -> None:
        # session.archive 是 server 造的合成方法、tui_gateway 沒有 → 連接器自己寫 state.db。
        # 自驅會話用持久映射的 state.db id（運行時句柄不是庫行）；導入會話 fallback 用原值。
        real = self._stored.get(server_sid) or self._fwd.get(server_sid, server_sid)

        def _do():
            db = self._session_db()
            sid = db.resolve_session_id(real) or real
            return sid, db.set_session_archived(sid, archived)

        sid, ok = await asyncio.to_thread(_do)
        print(f"· session.archive {sid} → archived={archived}（{'ok' if ok else 'no-op'}）")

    async def _attach_to_session(self, real_sid: str, ref: dict) -> None:
        # 入站附件：下載 presigned url → image.attach/file.attach；隨後的 prompt.submit 會帶上。
        path = await asyncio.to_thread(_materialize_attachment, ref)
        method = "image.attach" if ref.get("kind") == "image" else "file.attach"
        await self.gw.request(method, {"session_id": real_sid, "path": path})
        print(f"· 附件 {method} {ref.get('name')!r} → {real_sid}")

    async def _send_voice_transcript(
        self, server_sid: str, attachment_id, text: str, error: str | None = None
    ) -> None:
        # 語音輸入回填：把 audio 附件轉錄出的文字回傳 server（按 attachmentId 定位那條 user 消息）。
        msg = {
            "t": "voice_transcript",
            "agentLinkId": self.agent_link_id,
            "sessionId": server_sid,
            "attachmentId": attachment_id,
            "text": text or "",
        }
        if error:
            msg["error"] = error
        await self._send(msg)
        tail = f", err={error}" if error else ""
        print(f"· 語音轉錄回填 → server（{len(text or '')} 字{tail}）")

    async def _auto_title(self, server_sid: str, first_user_text: str) -> None:
        """#94：Macchiato 發起的會話首次發話 → 立即生成標題(越早越好)。**復用 Hermes 自己的
        title_generator**（用它配置的 `title_generation` 模型,provider:auto = 用戶自己的設置,支持
        訂閱;絕不 hardcode provider/model——見根 CLAUDE.md 鐵律）。已有非空標題則跳過(重啟後不重生)。"""
        try:
            real = self._stored.get(server_sid) or self._fwd.get(server_sid, server_sid)
            if await asyncio.to_thread(self._has_title, real):
                return  # 已有標題(用戶設的/上次生成的)→ 不重生
            title = await asyncio.to_thread(self._hermes_gen_title, first_user_text)
            if not title:
                return
            await self._to_server(
                server_sid,
                {"jsonrpc": "2.0", "method": "event", "params": {"type": "session.title", "session_id": server_sid, "payload": {"title": title}}},
            )
            print(f"· 自動生成標題「{title}」→ {server_sid}", file=sys.stderr)
        except Exception as exc:
            print(f"[auto_title failed for {server_sid}] {exc!r}", file=sys.stderr)

    @staticmethod
    def _has_title(state_sid: str) -> bool:
        """state.db 該會話是否已有非空標題（重啟後避免重生;渠道會話 Hermes 已起名）。"""
        import sqlite3

        db = os.path.expanduser("~/.hermes/state.db")
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            row = con.execute("select title from sessions where id=?", (state_sid,)).fetchone()
            return bool(row and (row[0] or "").strip())
        except Exception:
            return False
        finally:
            con.close()

    @staticmethod
    def _hermes_gen_title(user: str) -> str:
        """復用 Hermes 自帶起名（同 venv import）：用 Hermes 配置的 title_generation 模型。
        main_runtime=None → Hermes 回退到其輔助 LLM 客戶端（按用戶 config 的 provider:auto）。
        越早生成 → 只有首條 user 文本(assistant 傳空,generate_title 仍能起名,實測可用)。"""
        try:
            from agent.title_generator import generate_title

            return (generate_title(user, "", main_runtime=None) or "")[:80]
        except Exception as exc:
            print(f"[auto_title gen failed] {exc!r}", file=sys.stderr)
            return ""

    def _e2e_live_frame(self, server_sid: str, etype: str, payload: dict) -> dict | None:
        """§19 E2E 會話的 live 事件過濾(#240)。返回要轉發的 event frame,或 None(抑制)。
        - approval.request:命令/說明加密進 enc,明文只留占位 + pattern_key/request_id(元數據);
          server 盲存密文、不落明文,iOS 用 K_S 解密渲染。choice 回程非敏感,照 approval.respond 舊路。
        - 其餘(message.*/tool.* 走加密鏡像;clarify/secret 待雙向加密 follow-up):抑制。"""
        if etype != "approval.request":
            return None
        enc = self._e2e.encrypt_content(
            server_sid,
            {"command": payload.get("command", ""), "description": payload.get("description", "")},
        )
        out = {
            "command": "🔒 加密審批請求",
            "pattern_key": payload.get("pattern_key", ""),
            "pattern_keys": payload.get("pattern_keys", []),
            "description": "",
            "enc": enc,
        }
        if payload.get("request_id"):
            out["request_id"] = payload["request_id"]
        return {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {"type": "approval.request", "session_id": server_sid, "payload": out},
        }

    async def _emit_media_from_text(self, server_sid: str, text: str) -> None:
        # 出站附件：agent 在正文用 MEDIA:/裸路徑標的文件 → 讀取 → media.attach 事件上送。
        try:
            paths = await asyncio.to_thread(_extract_media_files, text)
        except Exception as exc:
            print(f"[extract_media failed] {exc!r}", file=sys.stderr)
            return
        for path in paths:
            try:
                payload = await asyncio.to_thread(_read_media_file, path)
            except Exception as exc:
                print(f"[read media {path} failed] {exc!r}", file=sys.stderr)
                continue
            if payload is None:
                continue
            frame = {
                "jsonrpc": "2.0",
                "method": "event",
                "params": {"type": "media.attach", "session_id": server_sid, "payload": payload},
            }
            await self._to_server(server_sid, frame)
            print(f"· media.attach {payload['name']}（{payload['size']}B）→ {server_sid}")

    def _load_stored(self) -> dict:
        # #248 主檔壞/缺 → 試 .bak(此前無備份:sessions.json 損壞即自驅會話 server↔state.db
        # 映射蒸發,E2E 投遞/重啟 resume/歸檔回寫全丟)。兩檔都壞才回空。
        for path in (SESSIONS_MAP, SESSIONS_MAP + ".bak"):
            try:
                with open(path) as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    return d
            except (FileNotFoundError, ValueError):
                continue
        return {}

    def _record_stored(self, server_sid: str, stored) -> None:
        """記住自驅會話的 state.db id（create 返回的 stored_session_id）。冪等、原子持久化 + .bak 輪替。"""
        if not stored or stored == server_sid or self._stored.get(server_sid) == stored:
            return
        self._stored[server_sid] = stored
        self._stored_rev[stored] = server_sid
        try:
            os.makedirs(os.path.dirname(SESSIONS_MAP), exist_ok=True)
            tmp = SESSIONS_MAP + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self._stored, f)
            if os.path.exists(SESSIONS_MAP):
                os.replace(SESSIONS_MAP, SESSIONS_MAP + ".bak")  # #248 輪替備份(load 側有 .bak 回退)
            os.replace(tmp, SESSIONS_MAP)
        except Exception as exc:
            print(f"[sessions map save failed] {exc!r}", file=sys.stderr)

    async def _ensure_session(self, server_sid: str) -> str:
        real = self._fwd.get(server_sid)
        if real:
            return real
        assert self.gw is not None
        # 續聊 vs 新建：先試 session.resume（導入/既有會話：server sid 就是 state.db id；
        # 自驅會話：server sid 對不上 → 用持久映射的 state.db id 續聊——gateway/連接器重啟後
        # 上下文不丟、消息續落原 state.db 會話）。都失敗才 session.create。
        targets = [server_sid]
        mapped = self._stored.get(server_sid)
        if mapped and mapped not in targets:
            targets.append(mapped)
        real = None
        for target in targets:
            try:
                res = await self.gw.request("session.resume", {"session_id": target})
                real = (res or {}).get("session_id") or target
                print(f"· resumed hermes session {real}（帶上下文續聊，target={target}）")
                break
            except GatewayDied:
                # #251(#1):gateway 重啟中 ≠ 會話不存在——GatewayDied 是「請求沒送達」,不是「無此會話」。
                # 此前被 except GatewayError 一起吞、誤走 create 建了個空會話,原會話上下文丟失(agent「失憶」)。
                # 上拋,讓調用方等 gateway 就緒後重投(帶持久映射 resume,上下文不丟)。
                raise
            except GatewayError:
                continue
        if real is None:
            cwd = self._cwds.get(server_sid)
            res = await self.gw.create_session(**({"cwd": cwd} if cwd else {}))  # #227 per-session cwd
            real = res.get("session_id")
            stored = (res or {}).get("stored_session_id")
            self._record_stored(server_sid, stored)
            print(f"· created hermes session {real} ← server {server_sid}（state.db={stored}）")
        self._fwd[server_sid] = real
        self._rev[real] = server_sid
        return real

    async def _retry_prompt(self, server_sid: str, text: str, attachments: list | None = None) -> None:
        """#4 prompt 級重試:gateway 死於 prompt.submit 在途 → 等重啟就緒後重投一次。

        安全性:GatewayDied = 請求確定沒收到響應,且在途回合隨 gateway 進程一起死了
        (turn 跑在 gateway 進程內)——重投不會造成 agent 跑兩個回合。
        去重:同 (會話, 文本哈希) 只重投**一次**——重投路徑再死已是連環故障,寧丟勿雙發
        (且 state.db 可能已落過一次 user 消息,二投會刷屏)。
        映射:_on_gateway_restart 已清 _fwd/_rev → _ensure_session 走持久映射 resume,帶上下文。
        非 audio 附件重新 attach(舊 gateway 進程裡 attach 的隨進程丟了);audio 的轉錄已折進 text。
        """
        key = (server_sid, hashlib.sha256(text.encode("utf-8")).hexdigest())
        if key in self._prompt_retried:
            print(f"[#4 重投已用過,放棄 {server_sid}]", file=sys.stderr)
            return
        if len(self._prompt_retried) > 512:  # 防無界(正常情況下極少進來)
            self._prompt_retried.clear()
        self._prompt_retried.add(key)
        try:
            deadline = time.monotonic() + 180  # 覆蓋 supervise 的重啟退避(3→60s);配置壞掉則放棄
            while time.monotonic() < deadline:
                if self.gw is not None and self.gw.ready():
                    break
                await asyncio.sleep(1.0)
            else:
                print(f"[#4 重投放棄:gateway 180s 未就緒 {server_sid}]", file=sys.stderr)
                return
            real = await self._ensure_session(server_sid)
            for ref in attachments or []:
                try:
                    await self._attach_to_session(real, ref)
                except Exception as exc:
                    print(f"[#4 重投 attach 失敗 {ref.get('name')!r}] {exc!r}", file=sys.stderr)
            try:
                await self.gw.submit_prompt(real, text)
            except GatewayError as exc:
                if exc.code == 4009 and text:
                    await self.gw.steer(real, text)
                else:
                    raise
            print(f"· #4 prompt 重投成功 {server_sid}(gateway 死於在途,已補投)")
            self._count("promptRetries")  # #10
        except Exception as exc:
            self._count("promptRetryFails")  # #10
            print(f"[#4 重投失敗,放棄 {server_sid}] {exc!r}", file=sys.stderr)
        finally:
            # #5:出賬。CancelledError(用戶中斷取消重投)不落 except Exception,直接穿透——正確。
            self._retry_tasks.pop(server_sid, None)

    async def _backfill_srcids(self, server_sid: str) -> None:
        """#13 統一消息身份:回合結束後,把本回合寫進 state.db 的行 id 回填給 server,
        作 live 消息的 dedup_key(與鏡像 srcId 收斂同鍵)——此後鏡像重發同源內容
        (gateway 重啟水位線競態 / nack 重試)被唯一索引吃掉,live × mirror 不再雙份。
        Hermes 在 message.complete **之後**才把回合消息批量寫庫 → 輪詢等行出現(≤10s)。"""
        floor = self._turn_floor.get(server_sid)
        stored = self._stored.get(server_sid)
        if floor is None or not stored:
            return
        try:
            deadline = time.monotonic() + float(os.environ.get("MACCHIATO_SRCID_WAIT_S", "10"))
            rows: list = []
            while True:
                rows = await turn_rows(stored, floor)
                if any(r[1] == "assistant" for r in rows) or time.monotonic() >= deadline:
                    break
                await asyncio.sleep(0.5)
            items = []
            last_user = max((r[0] for r in rows if r[1] == "user"), default=None)
            last_assistant = max((r[0] for r in rows if r[1] == "assistant"), default=None)
            if last_user is not None:
                items.append({"role": "user", "srcId": str(last_user)})
            if last_assistant is not None:
                items.append({"role": "agent", "srcId": str(last_assistant)})
            if not items:
                return
            self._turn_floor[server_sid] = max(r[0] for r in rows)  # 下回合 floor 順勢推進
            await self._send({
                "t": "message_srcid",
                "agentLinkId": self.agent_link_id,
                "sessionId": server_sid,
                "items": items,
            })
            self._count("srcidBackfills")  # #10
        except Exception as exc:
            print(f"[#13 srcid 回填失敗(忽略) {server_sid}] {exc!r}", file=sys.stderr)

    async def _send(self, msg: dict) -> bool:
        """斷線期間**緩衝**、ready 後按序補發(此前直接丟——server 部署重啟撞上進行中回合,
        回覆/標題被靜默丟掉,會話卡成「影子」,2026-07-12 實測)。鏡像/健康/pong 有自愈或時效性,照舊丟。
        返回「是否已實際發出」(緩衝/丟棄 → False)——鏡像靠它決定推不推水位線(#239):
        失敗批若照推,server 沒收到就永不 nack,消息永久丟失且無自愈路徑。"""
        data = json.dumps(msg, ensure_ascii=False)
        # #251:只在 ready(已收 t:"ready")後直發——handshaking 窗口(ws 已置但未認證)直發會發出
        # 未認證幀;ready 補發期間新幀也走緩衝、由補發循環按序帶出,不繞過隊列亂序。
        if self.ws is not None and self._linkb_ready:
            try:
                await self.ws.send(data)
                return True
            except Exception as exc:
                print(f"[send failed → 緩衝] {exc!r}", file=sys.stderr)
        if msg.get("t") in ("mirror_append", "connector_health", "pong"):
            return False
        self._out_pending.append(data)
        return False

    async def _start_push_socket(self) -> None:
        """§17 主動投遞：本地 unix socket 接 Hermes macchiato 插件的投遞請求 → 經 Link B 發 connector_push。"""
        os.makedirs(os.path.dirname(PUSH_SOCK), exist_ok=True)
        try:
            if os.path.exists(PUSH_SOCK):
                os.unlink(PUSH_SOCK)
        except OSError:
            pass
        try:
            self._push_server = await asyncio.start_unix_server(self._push_handler, path=PUSH_SOCK)
            os.chmod(PUSH_SOCK, 0o600)  # 僅本用戶可投遞（本機 IPC）
            print(f"· 主動投遞 socket 已啟（{PUSH_SOCK}）")
        except Exception as exc:
            print(f"[push socket 啟動失敗] {exc!r}", file=sys.stderr)

    async def _push_handler(self, reader, writer) -> None:
        """單條請求：讀一行 JSON {chatId,text,...} → 經 Link B 發 connector_push → 回 ack 行。"""
        ack: dict = {"ok": False, "error": "unknown"}
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            req = json.loads(line.decode("utf-8")) if line else {}
            chat_id = str(req.get("chatId") or "")
            # #160 deliver-to-origin:chatId 若是本地 state.db 會話 id → 翻譯成 server sid
            # (server 按 hermesSessionId 歸位原會話;翻不出原樣傳,home/自定義名照舊落收件箱)。
            chat_id = self._stored_rev.get(chat_id, chat_id)
            text = req.get("text") or ""
            if not chat_id or not text:
                ack = {"ok": False, "error": "missing chatId/text"}
            elif self.ws is None:
                ack = {"ok": False, "error": "link B down", "retryable": True}
            else:
                self._push_seq += 1
                pid = self._push_seq
                msg = {
                    "t": "connector_push",
                    "agentLinkId": self.agent_link_id,
                    "chatId": chat_id,
                    "text": text,
                    "pushId": pid,
                }
                if req.get("replyTo"):
                    msg["replyTo"] = req["replyTo"]
                if req.get("metadata"):
                    msg["metadata"] = req["metadata"]
                await self._send(msg)
                print(f"· 主動投遞 → server（chat={chat_id[:24]}, push {pid}, {len(text)} 字）")
                ack = {"ok": True, "messageId": f"push:{pid}"}
        except asyncio.TimeoutError:
            ack = {"ok": False, "error": "read timeout"}
        except Exception as exc:
            ack = {"ok": False, "error": repr(exc)}
        try:
            writer.write((json.dumps(ack) + "\n").encode("utf-8"))
            await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _advertise_import(self) -> None:
        """ready 後：上報可導入的歷史會話數（web 據此彈提示卡）。"""
        try:
            n = await count_importable(self.gw)
        except Exception as exc:
            print(f"[import_available failed] {exc!r}", file=sys.stderr)
            return
        print(f"· 可導入歷史會話: {n}")
        await self._send({"t": "import_available", "count": n})

    async def _maybe_auto_import(self) -> None:
        """#154 首裝自動全量導入(拍板:Hermes/OpenClaw 不請示用戶):水位線文件從未存在
        = 首次安裝 → 自動把全部歷史 import_batch 回灌(等價用戶點「導入」;server 按
        dedup_key 去重,非 replace 模式跳過已有)。既有安裝**不**觸發——自動 replace 會
        重置用戶手動改過的標題。auto_imported 記進鏡像狀態,at-most-once。"""
        if not self._fresh_install:
            return
        if MIRROR_OFF:
            # #308:自動吸入終端歷史同屬「終端側活動進 app」語義,跟隨鏡像開關;
            # app 裡的「導入」按鈕(import_start)是用戶顯式動作,保留不動。
            return
        st = self._mirror_st or self._load_mirror_state()
        if st.get("auto_imported"):
            return
        st["auto_imported"] = True
        self._mirror_st = st
        self._save_mirror_state(st)
        print("· #154 首裝偵測 → 自動全量導入歷史(無需請示)")
        await self._run_import()

    async def _run_import(self) -> None:
        """收到 import_start：枚舉磁盤歷史，分批 import_batch 回傳給 server。"""
        print("· 收到 import_start，枚舉並分批回傳…")
        try:
            sessions = await enumerate_importable(self.gw)
        except Exception as exc:
            print(f"[import enumerate failed] {exc!r}", file=sys.stderr)
            await self._send({"t": "import_batch", "sessions": [], "done": True})
            return
        if not sessions:
            await self._send({"t": "import_batch", "sessions": [], "done": True})
            return
        for i in range(0, len(sessions), IMPORT_BATCH):
            chunk = sessions[i : i + IMPORT_BATCH]
            await self._send(
                {"t": "import_batch", "sessions": chunk, "done": i + IMPORT_BATCH >= len(sessions)}
            )
            print(f"  → import_batch {i // IMPORT_BATCH + 1}: {len(chunk)} 會話")
        print(f"✓ 導入回傳完成：{len(sessions)} 個會話")

    # ── §15 全渠道持續鏡像（tail state.db → mirror_append）──────────────────

    def _load_mirror_state(self) -> dict:
        # #6:主文件損壞/丟失 → 先試 .bak(每次保存輪替的上一版,最多落後一批)。
        # 直接重設基線會把「舊水位線→現在」之間的消息永久跳過;.bak 只是舊一點,
        # 重發由 server srcId 去重兜住——寧可重發,不可靜默丟。
        for path, is_bak in ((MIRROR_STATE, False), (MIRROR_STATE + ".bak", True)):
            try:
                with open(path) as f:
                    st = json.load(f)
                st.setdefault("sessions", {})
                st.setdefault("tombstones", [])  # #161 墓碑:app 刪過的會話,鏡像永不再撈
                if is_bak:
                    print(
                        f"⚠️ mirror.json 損壞/丟失 → 已從 .bak 恢復水位線（{path}）。"
                        "如是有意重置請連 .bak 一併刪除。",
                        file=sys.stderr,
                    )
                return st
            except (FileNotFoundError, ValueError) as exc:
                if not isinstance(exc, FileNotFoundError):
                    print(f"[mirror state 損壞 {path}] {exc!r}", file=sys.stderr)
                continue
        return {"baseline": None, "sessions": {}}

    def _save_mirror_state(self, st: dict) -> None:
        try:
            # #262 dirty 判斷:與上次落盤相同 → 跳過(鏡像每 2s 輪詢,無條件雙寫傷 SD 卡;Pi 前科)。
            data = json.dumps(st, sort_keys=True)
            if data == getattr(self, "_mirror_last_saved", None):
                return
            os.makedirs(os.path.dirname(MIRROR_STATE), exist_ok=True)
            tmp = MIRROR_STATE + ".tmp"
            with open(tmp, "w") as f:
                f.write(data)
            # #6:輪替備份——上一版留作 .bak,主文件損壞時兜底(見 _load_mirror_state)。
            if os.path.exists(MIRROR_STATE):
                os.replace(MIRROR_STATE, MIRROR_STATE + ".bak")
            os.replace(tmp, MIRROR_STATE)
            self._mirror_last_saved = data
        except Exception as exc:
            print(f"[mirror state save failed] {exc!r}", file=sys.stderr)

    # ── 健康自檢 / 上報（#1 兼容自檢 + #2 健康上報）─────────────────────────

    def _log_compat(self) -> None:
        ver = self._compat.get("hermes_version")
        checks = self._compat.get("checks", {})
        bad = {k: v for k, v in checks.items() if v is not True}
        print(f"· Hermes 兼容自檢：version={ver}，{len(checks) - len(bad)}/{len(checks)} 通過")
        for k, v in bad.items():
            print(f"  ⚠️  {k} → {v}", file=sys.stderr)
        if bad:
            self._last_error = "compat: " + ", ".join(bad)
            print(
                "  ⚠️  Hermes 內部 API 不匹配（疑似 Hermes 自動更新）——相關功能可能失效！",
                file=sys.stderr,
            )

    def _degrade_reason(self) -> str | None:
        """#112:compat 探測失敗項 / 解析冒煙失敗 → 一句可讀原因(app 顯示「降級+為什麼」,
        而非一個沉默的布爾)。無降級 → None(lastError 回落鏡像錯誤)。"""
        gw = self.gw
        rf = getattr(gw, "restart_failures", 0) if gw is not None else 0
        if rf >= 3:
            return f"gateway 連續 {rf} 次重啟失敗(Hermes 配置壞了?)"  # #3
        checks = self._compat.get("checks", {})
        fails = [f"{k}: {v}" for k, v in checks.items() if v is not True]
        if fails:
            return ("compat " + "; ".join(fails))[:300]
        if self._smoke_err:
            return self._smoke_err[:300]
        return None

    def _count(self, key: str, n: int = 1) -> None:
        """#10:累計計數。懶初始化——#129 的教訓:別讓 __new__ 手搭的測試對象缺屬性就炸。"""
        c = getattr(self, "_counters", None)
        if c is None:
            c = self._counters = {}
        c[key] = c.get(key, 0) + n

    def _health(self) -> dict:
        checks = self._compat.get("checks", {})
        now = time.time()
        return {
            "ts": int(now),
            "uptimeS": int(now - self._started_at),
            "linkB": self._linkb_state,
            "gatewayAlive": bool(self.gw and self.gw.is_alive()),
            "hermesVersion": self._compat.get("hermes_version"),
            # #112:compat 探測 + 解析冒煙,任一失敗 → 降級
            "compatOk": bool(checks) and all(v is True for v in checks.values()) and self._smoke_err is None,
            "compat": checks,
            "mirrorLastPollAgeS": (
                int(now - self._mirror_last_run) if self._mirror_last_run else None
            ),
            "lastError": self._degrade_reason() or self._last_error,
            "connectorVersion": CONNECTOR_VERSION,  # §update：server 據此判 updateAvailable
            "kind": "hermes",  # #94：client gate 專屬功能（如 AI 重命名）
            "stt": _stt_available(),  # #89：語音轉錄能力位（false → server 走雲端 BYOK STT）
            "counters": dict(getattr(self, "_counters", {}) or {}),  # #10：累計計數（進程生命週期）
        }

    def _self_update(self) -> None:
        """§update：收到 server 的 self_update → **驗證鏈全過才執行**（#1 供應鏈加固）：
        release.json+.sig 內嵌公鑰驗簽 → 拒絕降級 → install.sh sha256 對上清單 → 從本地
        臨時文件跑（非 curl|bash 管道），清單經 MACCHIATO_MANIFEST 傳入供逐文件校驗。
        systemd 重啟會殺掉本進程並起新版；非 systemd（手動跑）則只更新文件、下次重啟生效。"""
        print("· 收到 self_update → 驗證發布簽名…", file=sys.stderr)
        try:
            import tempfile
            import urllib.request

            import release_verify as rv

            base = os.environ.get(
                "MACCHIATO_RELEASE_BASE",
                "https://raw.githubusercontent.com/macchiato-chat/macchiato/main",
            )

            def fetch(path: str) -> bytes:
                url = f"{base}/{path}"
                if not url.startswith("https://"):
                    raise ValueError(f"拒絕非 https:{url}")
                with urllib.request.urlopen(url, timeout=30) as r:  # noqa: S310  # https 已強制
                    return r.read()

            manifest_bytes = fetch("release.json")
            m = rv.verify_manifest(manifest_bytes, fetch("release.json.sig").decode())
            rv.check_not_downgrade(m["version"], CONNECTOR_VERSION)
            install_sh = fetch("install.sh")
            want = m["files"].get("install.sh")
            got = rv.sha256_hex(install_sh)
            if not want or got != want:
                raise ValueError(f"install.sh sha256 不符(清單 {want} ≠ 實際 {got})")
            d = tempfile.mkdtemp(prefix="macchiato-update-")
            sh_path = os.path.join(d, "install.sh")
            mf_path = os.path.join(d, "release.json")
            with open(sh_path, "wb") as f:
                f.write(install_sh)
            with open(mf_path, "wb") as f:
                f.write(manifest_bytes)
            print(f"· 簽名/版本/哈希全過(v{m['version']})→ 後台安裝…", file=sys.stderr)
            env = dict(os.environ, MACCHIATO_ONLY="hermes", MACCHIATO_MANIFEST=mf_path)
            # detached：脫離本進程，免得服務重啟殺自己時把更新也中斷
            subprocess.Popen(
                ["bash", sh_path],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except Exception as exc:
            print(f"[self_update failed] {exc!r}", file=sys.stderr)
            self._last_error = f"self_update failed: {exc}"

    def _write_health_file(self, h: dict) -> None:
        try:
            os.makedirs(os.path.dirname(HEALTH_FILE), exist_ok=True)
            tmp = HEALTH_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(h, f, ensure_ascii=False, indent=2)
            os.replace(tmp, HEALTH_FILE)
        except Exception as exc:
            print(f"[health file write failed] {exc!r}", file=sys.stderr)

    async def _health_loop(self) -> None:
        """每 HEALTH_INTERVAL_S：寫本地 health.json + 發 connector_health（讓 server 看出降級）。"""
        while True:
            try:
                await asyncio.sleep(HEALTH_INTERVAL_S)
                self._smoke_err = await asyncio.to_thread(_smoke_parse_state_db)  # #112
                h = self._health()
                self._write_health_file(h)
                # 鏡像看門狗：輪詢時延遠超預期 → 循環卡死/靜默退出 → 抓棧 + 重啟自愈。
                age = h.get("mirrorLastPollAgeS")
                if age is not None and age > MIRROR_STUCK_S:
                    print(f"⚠️ 鏡像循環卡 {age}s（卡死/退出）→ dump 棧 + 重啟", file=sys.stderr)
                    self._last_error = f"mirror stuck {age}s → restarted"
                    if self._mirror_task is not None:
                        try:
                            self._mirror_task.print_stack(file=sys.stderr)  # 掛起點 / 退出異常
                        except Exception:
                            pass
                        if not self._mirror_task.done():
                            self._mirror_task.cancel()
                    self._mirror_last_run = time.time()
                    self._mirror_task = asyncio.create_task(self._mirror_loop())
                n = await asyncio.to_thread(_gc_attachments)
                if n:
                    print(f"· GC 過期附件 {n} 個")
                if self.ws is not None:
                    await self._send(
                        {"t": "connector_health", "agentLinkId": self.agent_link_id, "health": h}
                    )
            except asyncio.CancelledError:
                return
            except Exception as exc:
                print(f"[health loop error] {exc!r}", file=sys.stderr)

    def _mirror_handle_nack(self, batch_id) -> None:
        """收到 server 的 mirror_nack：回退該批會話的水位線 → 下輪重發（#3 防丟）。"""
        if self._mirror_st is None or batch_id is None:
            return
        for bid, rewind in self._mirror_rewind:
            if bid == batch_id:
                wm = self._mirror_st["sessions"]
                for sid, old in rewind.items():
                    wm[sid] = min(wm.get(sid, old), old)
                self._save_mirror_state(self._mirror_st)
                self._count("mirrorNacks")  # #10
                self._last_error = f"mirror_nack: batch {batch_id}"
                print(
                    f"· mirror_nack batch {batch_id}：回退 {len(rewind)} 會話水位線、下輪重發",
                    file=sys.stderr,
                )
                return

    def _mirror_entry(self, sid, title, source, archived, msgs, e2e):
        """構造一個鏡像批次條目。E2E 會話（方案 A）：標題 + 各消息內容加密、打 e2e 標記，server 盲存。"""
        if not e2e:
            return {
                "hermesSessionId": sid,
                "title": title,
                "source": source,
                "archived": bool(archived),
                "messages": msgs,
            }
        return {
            "hermesSessionId": sid,
            "title": self._e2e.encrypt_text(sid, title or ""),  # 標題也加密
            "source": source,
            "archived": bool(archived),
            "e2e": True,
            "messages": [
                {
                    "role": m["role"],
                    "createdAt": m.get("createdAt"),
                    **({"srcId": m["srcId"]} if m.get("srcId") else {}),  # §9：srcId 是元數據、不加密，保留供去重
                    "enc": self._e2e.encrypt_content(
                        sid,
                        {"text": m.get("text", ""), "reasoning": m.get("reasoning"), "tools": m.get("tools")},
                    ),
                }
                for m in msgs
            ],
        }

    def _get_mirror_lock(self) -> asyncio.Lock:
        # 鏡像輪詢 ↔ E2E 歷史回灌互斥。懶建（need running loop）；getattr 兼容測試裸構造。
        if getattr(self, "_mirror_lock", None) is None:
            self._mirror_lock = asyncio.Lock()
        return self._mirror_lock

    def _prune_mirror_state(self, st: dict) -> None:
        """#9:裁掉長期不活躍的水位線,mirror.json 不再無界增長。

        安全性:閒置 ≥MIRROR_PRUNE_S 的會話早已鏡像到頂(floor==max)。裁掉後其 floor 記進
        pruned_floor(取全體被裁者最大值);未知會話的 floor 回退 max(baseline, pruned_floor)——
        被裁會話若復活,新消息 id 必大於裁剪時的全庫 max ≥ pruned_floor → 不丟不重。
        代價:從未鏡像過的被過濾會話若日後變 keepable,只補 pruned_floor 之後的消息
        (少量陳年消息不回填,可接受)。titles/touched_at 同步清理。"""
        wm, ta = st["sessions"], st.setdefault("touched_at", {})
        now = time.time()
        for sid in wm:
            ta.setdefault(sid, int(now))  # 升級前的舊條目:從現在起算齡(寬限一個週期)
        stale = [sid for sid in list(ta) if sid not in wm or now - ta[sid] > MIRROR_PRUNE_S]
        pruned = 0
        for sid in stale:
            if sid in wm:
                st["pruned_floor"] = max(st.get("pruned_floor", 0), wm.pop(sid))
                pruned += 1
            ta.pop(sid, None)
            st.setdefault("titles", {}).pop(sid, None)
        if pruned:
            self._save_mirror_state(st)
            print(f"· #9 裁剪 {pruned} 個閒置水位線（剩 {len(wm)}，pruned_floor={st['pruned_floor']}）")

    async def _mirror_loop(self) -> None:
        """tail state.db：把其他渠道（Discord/Telegram/…）的新消息 mirror_append 給 server。"""
        st = self._mirror_st = self._load_mirror_state()
        if st.get("baseline") is None:
            st["baseline"] = await current_max_id()  # 基線=當前 max；只鏡像此後的新消息
            self._save_mirror_state(st)
            print(f"· 鏡像基線 messages.id={st['baseline']}")
        baseline, wm = st["baseline"], st["sessions"]
        titles = st.setdefault("titles", {})  # 已發 server 的標題：偵測 Hermes 回合後才取名 → 純標題更新
        self._prune_mirror_state(st)  # #9:啟動時裁一次
        last_prune = time.time()
        while True:
            try:
                await asyncio.sleep(MIRROR_POLL_S)
                self._mirror_last_run = time.time()
                if time.time() - last_prune > 24 * 3600:  # #9:長駐進程每日裁一次
                    self._prune_mirror_state(st)
                    last_prune = time.time()
                if self.ws is None:
                    continue
                # 與 _e2e_backfill_history 互斥：回灌快照/替換期間不得按舊水位線追加（重複投遞）。
                async with self._get_mirror_lock():
                    await self._mirror_poll_once(st, baseline, wm, titles)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                self._count("mirrorErrors")  # #10
                print(f"[mirror loop error] {exc!r}", file=sys.stderr)

    async def _mirror_poll_once(self, st, baseline, wm, titles) -> None:
        batch, touched, title_updates = [], {}, {}
        # #9:未知會話的 floor 回退 max(baseline, pruned_floor)——被裁會話復活不重發舊消息。
        default_floor = max(baseline, st.get("pruned_floor", 0))
        # #8:掃描下界=全體 floor 的最小值——只讓 sqlite 回「有新消息」的會話,
        # 不再每 2s 對全部歷史會話做 max(m.id) 聚合。
        global_min = min([default_floor, *wm.values()]) if wm else default_floor
        rows = list(await changed_sessions(global_min))
        seen = {r[0] for r in rows}
        # 收窄後,無新消息的已鏡像會話不再出現 → 純標題更新(Hermes 回合後才取名)用主鍵
        # IN 輕量補查 meta,maxid=None 走下面的 has_new=False 分支,行為與收窄前一致。
        missing = [s for s in wm if s not in seen]
        rows += [(s, src, t, a, None) for s, src, t, a in await sessions_meta(missing)]
        for sid, source, title, archived, maxid in rows:
            # sid = state.db 會話 id。自驅會話（Macchiato 新建）的 state.db id（= gateway
            # session_key，經 _stored 持久映射）≠ server 持久化 hermesSessionId；K_S 按持久化
            # id 鍵控、mirror 也須用持久化 id 才能落回原會話 → 先映射回 pid（運行時 _rev 或
            # 持久 _stored_rev）判 E2E / 加密 / 標識。讀消息與水位線仍按 state.db 的 sid。
            pid = self._rev.get(sid) or self._stored_rev.get(sid, sid)
            # #161 墓碑:app 側刪過 → 鏡像永不再撈(不刪 agent 側檔案;水位線照推免積壓)。
            tombs = st.get("tombstones", [])
            if sid in tombs or pid in tombs:
                # 直接推水位線(免拉低 global_min 掃描下界),不入 touched(那是「本批投遞的新水位」,
                # 值語義是 new_wm 非 bool——入錯會污染 advance);持久化搭下次 save 的車。
                if maxid is not None and maxid > wm.get(sid, 0):
                    wm[sid] = maxid
                continue
            e2e = self._e2e.is_e2e(pid)  # §19：E2E 會話走加密鏡像（方案 A），不跳過
            if (sid in self._rev or sid in self._fwd or sid in self._stored_rev) and not e2e:
                # 續聊 Discord 會話（source=discord，經 tui 驅動）：運行時 id ≠ 持久化 id、消息落
                # 持久化 id 下、鏡像看到的是它，故連 _fwd 一起查,否則重複投遞。macchiato 新建會話
                # （source=tui，_stored_rev 鍵）由 live 路徑獨佔投遞，同樣跳過。
                continue
            floor = wm[sid] if sid in wm else default_floor
            has_new = maxid is not None and maxid > floor
            job = cron_feed_target(source, title)
            if job is not None:
                if has_new:
                    # cron → 訂閱 feed：只取 agent 文字報告，併進合成線 cron:<job>（§16）。
                    msgs, new_wm = await tail_session(sid, floor)
                    reports = [
                        {"role": "agent", "text": m["text"], "createdAt": m.get("createdAt")}
                        for m in msgs
                        if m["role"] == "agent" and (m.get("text") or "").strip()
                    ]
                    if reports:
                        batch.append({
                            "hermesSessionId": f"cron:{job}",
                            "title": job,
                            "source": "cron_feed",
                            "archived": False,
                            "messages": reports,
                        })
                    touched[sid] = new_wm
                continue
            # §19：E2E 自驅會話 source=tui，會被 keepable 的 SKIP_SOURCES 濾掉——但它的內容
            # **只有**加密鏡像這一條路（live 被抑制），必須豁免；非 E2E 照常過濾。
            if not e2e and not keepable(source, title):
                continue
            if has_new:
                msgs, new_wm = await tail_session(sid, floor)
                if msgs:
                    batch.append(self._mirror_entry(pid, title, source, archived, msgs, e2e))
                    touched[sid] = new_wm
                    title_updates[sid] = title
            elif sid in wm and (title or "").strip() and titles.get(sid) != title:
                # 已鏡像過（server 上存在）、無新消息、但標題變了（Hermes 回合後才取名）→
                # 純標題更新（空消息）；server 據此把占位「(鏡像會話)」改成真標題。用 sid in wm
                # 而非 titles，使升級前**積壓**的卡住會話（titles 尚無記錄）首輪也補上。
                # 不入 touched（不推水位線）。server 對非占位的會話自會 no-op。
                batch.append(self._mirror_entry(pid, title, source, archived, [], e2e))
                title_updates[sid] = title
        if batch:
            self._mirror_batch_id += 1
            bid = self._mirror_batch_id
            rewind = {sid: (wm[sid] if sid in wm else default_floor) for sid in touched}  # advance 前的舊 floor
            ok = await self._send({
                "t": "mirror_append",
                "agentLinkId": self.agent_link_id,
                "batchId": bid,
                "sessions": batch,
            })
            if not ok:
                # #239:批根本沒到 server(斷線/半路失敗)→ 不推水位線、不記 rewind、不記標題,
                # 下輪 poll 原地重撈重發。照推的話 server 永不 nack(沒收到),消息永久丟失。
                self._count("mirrorSendFailed")
                print(f"[mirror batch {bid} 未發出 → 水位線不推進,下輪重試]", file=sys.stderr)
                return
            self._mirror_rewind.append((bid, rewind))
            # 修 B：只在水位線未被併發 nack 回退時推進（否則回退會被覆蓋 → 丟）。
            ta = st.setdefault("touched_at", {})
            for sid, new_wm in touched.items():
                if (wm[sid] if sid in wm else default_floor) == rewind[sid]:
                    wm[sid] = new_wm
                    ta[sid] = int(time.time())  # #9:記活躍時間,供裁剪判齡
            titles.update(title_updates)  # 發送成功才記，免得失敗後不再重發
            self._save_mirror_state(st)
            n = sum(len(s["messages"]) for s in batch)
            self._count("mirrorBatches")  # #10
            self._count("mirrorMessages", n)
            nt = sum(1 for s in batch if not s["messages"])
            extra = f"（含 {nt} 純標題更新）" if nt else ""
            print(f"· 鏡像 {len(batch)} 會話 / {n} 條 → server (batch {bid}){extra}")

    async def _e2e_snapshot(self, server_sid: str):
        """按 server sid 定位 state.db 會話並全量快照。導入/鏡像會話：hermesSessionId 就是
        state.db id；自驅會話用持久映射（_stored）；最後試運行時句柄（舊 Hermes 二者相同）。
        返回 (snap, state_sid)；找不到 → (None, None)。"""
        candidates = [server_sid]
        for cand in (self._stored.get(server_sid), self._fwd.get(server_sid)):
            if cand and cand not in candidates:
                candidates.append(cand)
        for cand in candidates:
            try:
                snap = await session_snapshot(cand)
            except Exception as exc:
                print(f"[E2E 快照失敗 {cand}] {exc!r}", file=sys.stderr)
                snap = None
            if snap is not None:
                return snap, cand
        return None, None

    async def _e2e_backfill_history(self, server_sid: str, mode: str = "enable") -> None:
        """§19 D2 / 關閉：state.db 全量歷史回灌 `e2e_backfill`，server 事務內原地替換。
        mode="enable"（新開啟）：K_S 重加密回灌，清 KEK 可解的舊明文 payload。
        mode="disable"（關閉）：**明文**回灌（server 恢復可讀+投影）、成功後刪本地 K_S。
        找不到 state.db 會話（自驅 tui 會話 id 未解析，見 E2E-5）→ found:false：enable 時
        server 歷史不替換（僅新消息加密）；disable 時關閉失敗、K_S 保留、會話保持加密。
        持 _mirror_lock 與鏡像輪詢互斥，並把該會話水位線推到快照覆蓋位——回灌已含全歷史，
        鏡像不得再按舊 floor 追加（重複投遞）。"""
        async with self._get_mirror_lock():
            snap, state_sid = await self._e2e_snapshot(server_sid)
            if snap is None or not snap["messages"]:
                await self._send({
                    "t": "e2e_backfill",
                    "agentLinkId": self.agent_link_id,
                    "hermesSessionId": server_sid,
                    "mode": mode,
                    "found": False,
                })
                tail = "關閉失敗、K_S 保留" if mode == "disable" else "server 歷史未替換"
                print(
                    f"· E2E 回灌({mode})：state.db 無會話 {server_sid}（或無已結算消息）"
                    f"→ found:false，{tail}",
                    file=sys.stderr,
                )
                return
            entry = self._mirror_entry(
                server_sid, snap["title"], snap["source"], snap["archived"], snap["messages"],
                mode == "enable",
            )
            await self._send({
                "t": "e2e_backfill",
                "agentLinkId": self.agent_link_id,
                "hermesSessionId": server_sid,
                "mode": mode,
                "found": True,
                "session": entry,
            })
            st = self._mirror_st or self._load_mirror_state()
            wm = st["sessions"]
            if snap["cover"] > wm.get(state_sid, 0):
                wm[state_sid] = snap["cover"]
                self._save_mirror_state(st)
            if mode == "disable":
                self._e2e.remove(server_sid)  # 關閉完成：刪 K_S，live/mirror 回明文路徑
            print(
                f"· E2E 回灌({mode})：{server_sid} 全歷史 {len(snap['messages'])} 條已回傳"
                f"（水位線→{snap['cover']}）"
            )

    async def _submit_final(self, server_sid: str, real: str, final_text: str, retry_refs: list) -> None:
        """提交一回合文本給 gateway(prompt.submit 與 #199 command.invoke 共用尾段):
        #13 記回合 floor → submit;GatewayDied → 後台重投(#4);4009 busy → steer 注入(#75 方案 D);
        成功 → 補償早到中斷(#5)。"""
        assert self.gw is not None
        # #13:記回合 floor——此後 > floor 的 state.db 行即本回合所寫,
        # 回合結束(message.complete)按它定位行 id 回填 live 消息身份。
        if self._stored.get(server_sid) and not self._e2e.is_e2e(server_sid):
            try:
                self._turn_floor[server_sid] = await current_max_id()
            except Exception:
                pass  # 拿不到 floor → 本回合不回填,會話級跳過照舊兜底
        try:
            await self.gw.submit_prompt(real, final_text)
        except GatewayDied:
            # #4:gateway 死於 prompt 在途——請求確定沒完成(在途回合也隨進程死了)。
            # 後台等 gateway 重啟就緒後重投一次(去重見 _retry_prompt),你那句話不再石沉。
            # 不 await:重啟可能要幾十秒,別堵住 Link B 的分派循環。
            self._retry_tasks[server_sid] = asyncio.create_task(
                self._retry_prompt(server_sid, final_text, retry_refs)
            )
        except GatewayError as exc:
            # 回合進行中（4009 session busy）→ steer 把跟進消息注入正在跑的回合（方案 D），
            # 不丟、不打斷；模型在下一次工具迭代時看到。純圖無文字無法 steer → 照舊上拋記日誌。
            if exc.code == 4009 and final_text:
                res = await self.gw.steer(real, final_text)
                print(f"· 回合進行中 → steer 注入跟進消息（status={(res or {}).get('status')}）")
            else:
                raise
        else:
            # 補償早到的中斷：prompt.submit 返回即「streaming」（回合在後台線程跑），
            # 此刻 interrupt 立即取消；turn_context 對剛起步的回合會保留此 interrupt。
            if server_sid in self._pending_interrupt:
                self._pending_interrupt.discard(server_sid)
                await self.gw.interrupt(real)
                print(f"· 補償早到中斷 → interrupt {real}（回合起步即取消）")

    async def _report_commands(self) -> None:
        """#199 枚舉 agent 命令/技能 → 上報 {t:"commands"}(整份替換,composer / 菜單數據源)。
        權威源 = tui_gateway RPC `commands.catalog`(已按平台過濾 disabled、已 dedup、描述已截 120)
        ——勿 dir-walk(磁碟 SKILL.md 遠多於 live 生效數,會多報),勿讀 .skills_prompt_snapshot.json
        (system-prompt 緩存會 stale)。失敗只缺菜單,靜默降級不影響其他功能。"""
        if self.gw is None or not self.gw.ready():
            return
        try:
            res = await self.gw.request("commands.catalog", {})
            pairs = (res or {}).get("pairs") or []
            n = int((res or {}).get("skill_count") or 0)
            cmds = []
            for item in pairs[-n:] if n > 0 else []:
                slug = str(item[0] if len(item) > 0 else "").strip().lstrip("/")
                desc = str(item[1] if len(item) > 1 else "").strip()
                if not slug:
                    continue
                cmds.append({"name": slug, **({"description": desc[:200]} if desc else {})})
            await self._send({"t": "commands", "agentLinkId": self.agent_link_id, "commands": cmds})
            print(f"· #199 命令枚舉:{len(cmds)} 條上報")
        except Exception as exc:
            print(f"[#199 commands.catalog 失敗(/菜單缺席,其餘不受影響)] {exc!r}", file=sys.stderr)

    # ── #227 Projects:備案目錄 project_op + 回合末惰性版本化 ─────────────────
    # 安全紀律(docs/projects.md):mem 操作只服務本地註冊表裡的路徑(server 被攻破也指不動);
    # 只碰 AGENTS.md 一個文件;原子寫;CLAUDE.md 墊片只在不存在時補(不踩用戶配置)。

    @staticmethod
    def _proj_canon(server_path: str) -> str:
        return os.path.realpath(os.path.expanduser(server_path))

    def _projects_load(self) -> None:
        try:
            with open(_projects_reg_path()) as f:
                data = json.load(f)
            for sp in data.get("paths", []):
                try:
                    self._projects[sp] = self._proj_canon(sp)
                except Exception:
                    pass
        except (FileNotFoundError, ValueError):
            pass

    def _projects_save(self) -> None:
        try:
            path = _projects_reg_path()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"v": 1, "paths": list(self._projects.keys())}, f)
            os.replace(tmp, path)
        except Exception as exc:
            print(f"[#227 projects registry save failed] {exc!r}", file=sys.stderr)

    @staticmethod
    def _proj_atomic_write(file: str, content: str) -> None:
        tmp = file + ".tmp"
        with open(tmp, "w") as f:
            f.write(content)
        os.replace(tmp, file)

    async def _project_op(self, msg: dict) -> None:
        req_id = msg.get("reqId")
        op = msg.get("op")

        def reply(**body):
            return self._send({"t": "project_op_result", "reqId": req_id, **body})

        try:
            if op == "register":
                await reply(**self._proj_register(str(msg.get("path") or ""), msg.get("mkdir") is True,
                                                  msg.get("agentsMd") if isinstance(msg.get("agentsMd"), str) else None))
            elif op == "mem_read":
                await reply(**self._proj_mem_read(str(msg.get("path") or ""), msg.get("file")))
            elif op == "mem_write":
                await reply(**self._proj_mem_write(str(msg.get("path") or ""),
                                                   msg.get("content") if isinstance(msg.get("content"), str) else None,
                                                   msg.get("file")))
            elif op == "registry":
                paths = msg.get("paths") if isinstance(msg.get("paths"), list) else []
                self._projects = {}
                for sp in paths:
                    try:
                        self._projects[sp] = self._proj_canon(sp)
                    except Exception:
                        pass
                self._projects_save()
                await reply(ok=True)
            else:
                await reply(ok=False, error=f"未知 op:{op}")
        except Exception as exc:
            await reply(ok=False, error=repr(exc)[:300])

    def _proj_register(self, server_path: str, mkdir: bool, agents_md) -> dict:
        if not server_path:
            return {"ok": False, "error": "缺 path"}
        canon = self._proj_canon(server_path)
        existed = os.path.exists(canon)
        if not existed:
            if not mkdir:
                return {"ok": False, "error": f"目錄不存在:{canon}(可勾選「自動創建」)"}
            os.makedirs(canon, exist_ok=True)
        if not os.path.isdir(canon):
            return {"ok": False, "error": f"不是目錄:{canon}"}
        if not os.access(canon, os.W_OK):
            return {"ok": False, "error": f"目錄不可寫:{canon}"}
        # 三態(同 TS): (A) 有 AGENTS.md 沿用; (B) 只有 CLAUDE.md 無 AGENTS.md → 遷移(改名+重建墊片);
        # (C) 都無/CLAUDE.md 已是純墊片 → 帶初始內容則寫 AGENTS.md,缺墊片補。
        ap = os.path.join(canon, "AGENTS.md")
        cp = os.path.join(canon, "CLAUDE.md")
        has_a = os.path.exists(ap)
        has_c = os.path.exists(cp)
        c_content = ""
        if has_c:
            with open(cp, encoding="utf-8", errors="replace") as f:
                c_content = f.read()
        existing = None
        wrote_shim = False
        migrated = False
        if has_a:
            with open(ap, encoding="utf-8", errors="replace") as f:
                existing = f.read()[:PROJ_MEM_MAX]
            if not has_c:
                self._proj_atomic_write(cp, PROJ_SHIM)
                wrote_shim = True
        elif has_c and c_content.strip() != "@AGENTS.md":
            os.rename(cp, ap)  # (B) 遷移:內容落到 AGENTS.md
            self._proj_atomic_write(cp, PROJ_SHIM)  # 重建一行墊片
            with open(ap, encoding="utf-8", errors="replace") as f:
                existing = f.read()[:PROJ_MEM_MAX]
            wrote_shim = True
            migrated = True
        else:
            if agents_md is not None:
                self._proj_atomic_write(ap, agents_md)
            if not has_c:
                self._proj_atomic_write(cp, PROJ_SHIM)
                wrote_shim = True
        content = existing if existing is not None else (agents_md or "")
        self._projects[server_path] = canon
        self._proj_last_hash[canon] = _mem_hash(content)
        self._projects_save()
        tag = "(CLAUDE.md→AGENTS.md 遷移)" if migrated else ("(+CLAUDE.md 墊片)" if wrote_shim else "")
        print(f"· #227 project 備案:{server_path}{tag}")
        return {"ok": True, "existed": existed, "agentsMd": existing, "hash": _mem_hash(content),
                "wroteShim": wrote_shim, "migratedClaudeToAgents": migrated}

    def _proj_require(self, server_path: str) -> str:
        canon = self._projects.get(server_path)
        if not canon:
            raise ValueError("路徑未備案(本地註冊表硬校驗)")
        return canon

    @staticmethod
    def _proj_file_for(file) -> str:
        """#227 具名文件白名單:AGENTS.md(默認,記憶)| CLAUDE.md(修墊片用)。其餘一律拒。"""
        if file is None or file == "AGENTS.md":
            return "AGENTS.md"
        if file == "CLAUDE.md":
            return "CLAUDE.md"
        raise ValueError(f"文件不在白名單:{file}")

    def _proj_mem_read(self, server_path: str, file=None) -> dict:
        canon = self._proj_require(server_path)
        name = self._proj_file_for(file)
        ap = os.path.join(canon, name)
        content = ""
        if os.path.exists(ap):
            with open(ap, encoding="utf-8", errors="replace") as f:
                content = f.read()[:PROJ_MEM_MAX]
        if name == "AGENTS.md":
            self._proj_last_hash[canon] = _mem_hash(content)
        return {"ok": True, "agentsMd": content, "hash": _mem_hash(content)}

    def _proj_mem_write(self, server_path: str, content, file=None) -> dict:
        canon = self._proj_require(server_path)
        name = self._proj_file_for(file)
        if content is None or len(content) > PROJ_MEM_MAX:
            return {"ok": False, "error": "內容缺失或超限"}
        self._proj_atomic_write(os.path.join(canon, name), content)
        if name == "AGENTS.md":
            self._proj_last_hash[canon] = _mem_hash(content)
        return {"ok": True, "hash": _mem_hash(content)}

    def _projects_check_turn_end(self) -> None:
        """#227 回合末惰性版本化:掃備案目錄(極少)的 AGENTS.md,hash 變了 → 推 project_mem_changed。
        未定基線(重啟後首回合)只定不推——重啟間隙的變化由面板打開時的穿透讀對賬兜住。"""
        for server_path, canon in list(self._projects.items()):
            try:
                ap = os.path.join(canon, "AGENTS.md")
                content = ""
                if os.path.exists(ap):
                    with open(ap, encoding="utf-8", errors="replace") as f:
                        content = f.read()[:PROJ_MEM_MAX]
                h = _mem_hash(content)
                prev = self._proj_last_hash.get(canon)
                self._proj_last_hash[canon] = h
                if prev is not None and prev != h:
                    asyncio.get_running_loop().create_task(self._send({
                        "t": "project_mem_changed", "agentLinkId": self.agent_link_id,
                        "path": server_path, "content": content, "hash": h,
                    }))
                    print(f"· #227 AGENTS.md 變更 → 落版本({server_path})")
            except Exception:
                pass  # 單目錄壞不擋其餘

    def _dispatch_session(self, server_sid: str, coro_factory) -> None:
        """#148:把慢工作掛到該會話的串行鏈上。讀循環立刻返回;同會話按序、跨會話並發。
        前任異常不斷鏈(已各自記日誌/計數);鏈尾完成且仍是尾 → 清條目防字典緩慢積長。"""
        prev = self._session_chains.get(server_sid)

        async def run():
            if prev is not None:
                try:
                    await prev
                except Exception:
                    pass  # 前任已自行記錄
            try:
                await coro_factory()
            except Exception as exc:
                self._count("dispatchErrors")  # #10
                print(f"[dispatch failed prompt.submit {server_sid}] {exc!r}", file=sys.stderr)

        task = asyncio.create_task(run())
        self._session_chains[server_sid] = task

        def _cleanup(t):
            if self._session_chains.get(server_sid) is t:
                self._session_chains.pop(server_sid, None)

        task.add_done_callback(_cleanup)

    async def _on_server_msg(self, raw) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        t = msg.get("t")
        if t == "ready":
            self._linkb_state = "connected"
            print("✓ link B ready — 連接器上線，等待 server 下達")
            if self._out_pending and self.ws is not None:
                n = len(self._out_pending)
                try:
                    # #251:先 peek 再 popleft——send 失敗時該幀不丟(此前 popleft 後 send 拋即丟一幀)。
                    while self._out_pending:
                        await self.ws.send(self._out_pending[0])
                        self._out_pending.popleft()
                    print(f"· 重連 → 補發斷線期間積壓的 {n} 幀")
                except Exception as exc:
                    print(f"[積壓補發失敗,剩 {len(self._out_pending)}] {exc!r}", file=sys.stderr)
            # #251:補發完成後才置 ready——補發期間並發的 _send 走緩衝、由上面循環按序帶出,不亂序。
            self._linkb_ready = True
            await self._advertise_import()
            await self._report_commands()  # #199 每次 ready 重發(server 重啟丟內存緩存)
            await self._maybe_auto_import()  # #154 首裝自動全量導入(不請示)
            return
        if t == "auth_error":
            reason = msg.get("reason")
            self._linkb_state = f"auth_error: {reason}"
            self._last_error = f"auth_error: {reason}"
            print(
                f"✗ auth_error: {reason}（憑證吊銷或 Hermes 升級致 proto 不符——需重新配對/升級）",
                file=sys.stderr,
            )
            # #246 auth_error 是終端態(非瞬時):此前只記狀態,外層 ≤1s 全速重連狂打 server
            # (收帧重置退避)。改為退出交 supervisor(systemd)——重試/最終 stop,不再殭屍空轉。
            self._on_fatal()
            return
        if t == "ping":
            if self.ws:
                await self.ws.send(json.dumps({"t": "pong"}))
            return
        if t == "import_start":
            await self._run_import()
            return
        if t == "mirror_nack":
            self._mirror_handle_nack(msg.get("batchId"))
            return
        if t == "self_update":
            self._self_update()
            return
        if t == "e2e_wrap_request":
            # §19：iOS 開啟某會話 E2E / 新設備加入 → 生成或取出 K_S，封裝給各設備公鑰、回傳。
            sid = msg.get("hermesSessionId")
            if sid:
                wrapped = self._e2e.wrap_for_devices(sid, msg.get("devices") or [])
                await self._send({
                    "t": "e2e_key",
                    "agentLinkId": self.agent_link_id,
                    "hermesSessionId": sid,
                    "wrapped": wrapped,
                })
                print(f"· E2E：會話 {sid} 封裝 K_S 給 {len(wrapped)} 台設備")
                if msg.get("backfill"):
                    # §19 D2 新開啟：把該會話全量歷史重加密回灌，server 原地替換明文。
                    asyncio.create_task(self._e2e_backfill_history(sid))
            return
        if t == "e2e_disable_request":
            # §19 關閉：明文回灌（server 恢復可讀+投影）→ 成功後刪本地 K_S。
            sid = msg.get("hermesSessionId")
            if sid:
                asyncio.create_task(self._e2e_backfill_history(sid, mode="disable"))
            return
        if t == "project_op":
            await self._project_op(msg)
            return
        if t != "tui":
            return

        frame = msg.get("frame") or {}
        method = frame.get("method")
        params = frame.get("params") or {}
        server_sid = params.get("session_id") or msg.get("sessionId")
        assert self.gw is not None

        try:
            if method == "prompt.submit":
                # #148:慢路徑(resume 往返/附件下載/STT)出讀循環——經 per-session 串行鏈派發,
                # 某會話的大附件/慢 STT 不再 head-of-line 阻塞其他會話。同會話仍按序。
                async def _do_prompt(params=params, server_sid=server_sid):
                    # #251(#1):文本裝配(標題/解密/STT)提前到 _ensure_session **之前**——這樣 gateway
                    # 死於建會話時,能拿已裝配好的 final_text 走重投(而非 _ensure_session 誤建空會話)。
                    attachments = params.get("attachments") or []
                    parts = []
                    base = (params.get("text") or "").strip()
                    # #94：Macchiato 發起的會話首次發話 → 立即用首條 user 文本自動生成標題(越早越好)。
                    # E2E 跳過(明文);已標題過跳過;_titled 防會話內重複。
                    if base and server_sid not in self._titled and not self._e2e.is_e2e(server_sid):
                        self._titled.add(server_sid)
                        asyncio.create_task(self._auto_title(server_sid, base))
                    if base and self._e2e.is_e2e(server_sid):
                        # §19 E2E：iOS 發來的是密文 → 解密後再提交 agent（gated，非 E2E 會話不走這）。
                        try:
                            base = self._e2e.decrypt_text(server_sid, base).strip()
                        except Exception as exc:
                            print(f"[E2E 解密 prompt 失敗 {server_sid}] {exc!r}", file=sys.stderr)
                            # #279:靜默丟=用戶氣泡「已發送」卻永無回應。回 error 終態回合
                            # (僅提示語,零內容洩漏),可見可重試;不把亂碼交給 agent 的語義不變。
                            for etype, payload in (
                                ("message.start", {}),
                                ("message.complete", {"text": "", "status": "error", "warning": E2E_DECRYPT_FAIL_WARNING}),
                            ):
                                await self._to_server(
                                    server_sid,
                                    {"jsonrpc": "2.0", "method": "event", "params": {"type": etype, "session_id": server_sid, "payload": payload}},
                                )
                            return
                    if base:
                        parts.append(base)
                    non_audio_refs = [r for r in attachments if r.get("kind") != "audio"]
                    for ref in attachments:
                        if ref.get("kind") == "audio":
                            # 語音輸入：本地 STT 轉錄 → 回填 server（顯示在 user 氣泡）+ 拼進發給 agent 的文字。
                            res = await asyncio.to_thread(_transcribe_attachment, ref)
                            transcript = (res.get("text") or "").strip()
                            await self._send_voice_transcript(server_sid, ref.get("id"), transcript, res.get("error"))
                            if transcript:
                                parts.append(transcript)
                    final_text = "\n\n".join(parts)
                    # 純語音且轉錄為空（STT 不可用/沒聽清）→ 不打擾 agent（server 已落兜底提示）。
                    non_audio = any(r.get("kind") != "audio" for r in attachments)
                    if not (final_text or non_audio or not attachments):
                        print("· 語音轉錄為空，跳過提交 agent（server 已落兜底）")
                        return
                    # 建/續會話。#251(#1):gateway 死於此 → 後台重投(帶已裝配 final_text + 非語音附件),
                    # 而非誤建空會話丟上下文。_ensure_session 已對 GatewayDied 上拋(不誤走 create)。
                    try:
                        real = await self._ensure_session(server_sid)
                    except GatewayDied:
                        self._retry_tasks[server_sid] = asyncio.create_task(
                            self._retry_prompt(server_sid, final_text, non_audio_refs)
                        )
                        return
                    for ref in non_audio_refs:
                        try:
                            await self._attach_to_session(real, ref)
                        except Exception as exc:
                            print(f"[attach failed {ref.get('name')!r}] {exc!r}", file=sys.stderr)
                    await self._submit_final(server_sid, real, final_text, non_audio_refs)
                self._dispatch_session(server_sid, _do_prompt)
            elif method == "command.invoke":
                # #199 命令/技能調用(composer / 菜單選中):**兩步**——prompt.submit 不展開 /slug
                # (harness 原文直達 agent),必須先 command.dispatch 拿展開全文,再走常規提交尾段
                # (steer/重投/floor 同 prompt 路徑)。慢路徑(dispatch RPC 往返)→ per-session 串行鏈。
                async def _do_invoke(params=params, server_sid=server_sid):
                    name = str(params.get("command") or "").strip().lstrip("/")
                    if not name:
                        return
                    arg = str(params.get("args") or "").strip()
                    real = await self._ensure_session(server_sid)
                    res = await self.gw.request(
                        "command.dispatch", {"name": "/" + name, "arg": arg, "session_id": real}
                    )
                    text = str((res or {}).get("message") or "").strip()
                    if not text:
                        # dispatch 沒展開(未知/被禁命令)→ 原文提交兜底,agent 至少看得見用戶意圖
                        text = f"/{name} {arg}".strip()
                        print(f"· #199 dispatch 未展開 /{name},原文提交兜底", file=sys.stderr)
                    await self._submit_final(server_sid, real, text, [])
                    print(f"· #199 command.invoke /{name} → {server_sid}(展開 {len(text)} 字)")
                self._dispatch_session(server_sid, _do_invoke)
            elif method == "approval.respond":
                # #251(#4):此前在讀循環內聯調 _ensure_session,與同會話 _do_prompt 的
                # _ensure_session 併發 → 雙 create、_fwd 覆寫、洩漏 gateway 會話。掛進 per-session
                # 串行鏈,和 prompt/invoke 排同一隊(審批發生在回合中、鏈通常已空,不增延遲)。
                async def _do_approval(params=params, server_sid=server_sid):
                    real = await self._ensure_session(server_sid)
                    await self.gw.request(
                        "approval.respond",
                        {"session_id": real, "choice": params.get("choice", "deny"), "all": params.get("all", False)},
                    )
                self._dispatch_session(server_sid, _do_approval)
            elif method == "session.interrupt":
                # #5:重投等待期(#4)收到中斷 → 取消重投——用戶已叫停的 prompt 不許復活雙發。
                rt = self._retry_tasks.pop(server_sid, None)
                if rt is not None and not rt.done():
                    rt.cancel()
                    print(f"· 用戶中斷 → 取消待重投 prompt({server_sid})")
                real = self._fwd.get(server_sid)
                if real:
                    await self.gw.interrupt(real)
                else:
                    # 回合真正開始前到達的中斷：會話映射尚未建立 → 別丟，記為 pending，
                    # 等 prompt 建立映射、回合起步後一起取消（見 prompt.submit 末尾）。
                    self._pending_interrupt.add(server_sid)
                    print(f"· interrupt 早到（{server_sid} 未映射）→ pending", file=sys.stderr)
            elif method == "session.create":
                # #227 cwd:草稿期傳來的工作目錄。未建會話 → 存起來,create 時帶上;已建 → session.cwd.set
                # 中途改(gateway 支持;session busy=agent 回覆過返 4009,Macchiato 側本就鎖 cwd、不該發)。
                cwd = str(params.get("cwd") or "").strip()
                # cwd 存儲同步(_do_prompt 的 _ensure_session 讀 self._cwds)——先於下面的建會話派發。
                if cwd:
                    self._cwds[server_sid] = cwd
                else:
                    self._cwds.pop(server_sid, None)

                # #251(#4):建會話/改 cwd 的 gateway 調用掛進 per-session 串行鏈,不再在讀循環內聯
                # 與 _do_prompt 的 _ensure_session 併發雙 create。
                async def _do_create(server_sid=server_sid, cwd=cwd):
                    real = self._fwd.get(server_sid)
                    if real is None:
                        await self._ensure_session(server_sid)
                    elif cwd:
                        try:
                            await self.gw.request("session.cwd.set", {"session_id": real, "cwd": cwd})
                            print(f"· #227 session.cwd.set {real} → {cwd}")
                        except GatewayError as exc:
                            if exc.code != 4009:  # 4009=busy(已鎖),其餘上拋
                                raise
                self._dispatch_session(server_sid, _do_create)
            elif method == "session.archive":
                await self._set_hermes_archived(server_sid, bool(params.get("archived", True)))
            elif method == "session.delete":
                # #161 墓碑語義:app 刪會話 → 連接器記墓碑,鏡像永不再撈;**不刪** agent 側檔案
                # (app 是遙控器,不該能燒掉主機的歷史)。server 側行已刪,這裡防「刪了又冒回來」。
                if self._mirror_st is not None:
                    tombs = self._mirror_st.setdefault("tombstones", [])
                    real = self._stored.get(server_sid) or self._fwd.get(server_sid, server_sid)
                    for t_id in {server_sid, real}:
                        if t_id and t_id not in tombs:
                            tombs.append(t_id)
                    self._save_mirror_state(self._mirror_st)
                    print(f"· session.delete {server_sid} → 墓碑(鏡像永不再撈)")
            elif method == "session.rename":
                # #161 手動改名回寫:app 改標題 → 寫回 state.db,Hermes TUI 兩邊一致。
                title = str(params.get("title") or "").strip()
                if title:
                    await self._set_hermes_title(server_sid, title)
            # session.retitle 已廢棄:改由首次 prompt.submit 自動生成標題(見上)。
            # session.delete / others: ignore for now
        except Exception as exc:
            # 兜底保連接器不被單幀弄死;但打全 traceback——#129 那次 AttributeError(編程錯誤)
            # 只剩一行 repr,測試斷言拿到空列表卻看不出錯在哪行。
            self._count("dispatchErrors")  # #10
            print(f"[dispatch {method} failed] {exc!r}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)


async def _main() -> int:
    server_url = os.environ.get("MACCHIATO_SERVER_URL")
    token = os.environ.get("MACCHIATO_CONNECTOR_TOKEN")
    agent_link_id = os.environ.get("MACCHIATO_AGENT_LINK_ID")

    # 回落到 pair.py 存下的憑證（~/.macchiato/connector.json）。
    cred_path = os.path.expanduser(os.environ.get("MACCHIATO_CRED", "~/.macchiato/connector.json"))
    if (not token or not agent_link_id) and os.path.exists(cred_path):
        with open(cred_path) as f:
            cred = json.load(f)
        token = token or cred.get("connector_token")
        agent_link_id = agent_link_id or cred.get("agent_link_id")
        server_url = server_url or cred.get("server_url")

    server_url = server_url or "ws://localhost:8080/connector"
    if not token or not agent_link_id:
        print(
            "FAIL: 未配對。先跑 pair.py，或設 MACCHIATO_CONNECTOR_TOKEN/MACCHIATO_AGENT_LINK_ID。",
            file=sys.stderr,
        )
        return 2
    c = Connector(server_url, token, agent_link_id)
    try:
        await c.run()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
