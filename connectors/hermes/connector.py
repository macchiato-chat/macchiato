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
  #379 本地 dev-disk 附件下載（生產默認拒 loopback）:
  MACCHIATO_ATTACH_ALLOW_LOCALHOST=1  才放行 http→localhost/127.0.0.1/::1
  MACCHIATO_ATTACH_LOCAL_PORT         可選，默認 8080（對齊 PUBLIC_SERVER_URL）
  MACCHIATO_ATTACH_LOCAL_PATH_PREFIX  可選，默認 /attachments
"""

from __future__ import annotations

import asyncio
import errno
import importlib
import json
import mimetypes
import os
import re
import stat
import http.client
import ipaddress
import socket
import ssl
import subprocess
import sys
import threading
import time
import traceback
import uuid
from collections import OrderedDict, deque
from urllib.parse import urlparse

import websockets

import hashlib

from gateway_client import GatewayClient, GatewayDied, GatewayError

# #380 Link B 傳輸邊界——對齊 server connectorWss maxPayload=8MiB（server.ts）。
LINKB_MAX_FRAME_BYTES = 8 * 1024 * 1024
LINKB_PENDING_MAX = 500
LINKB_PENDING_MAX_BYTES = 16 * 1024 * 1024
LINKB_MAX_TOP_LEVEL_KEYS = 64
LINKB_MAX_JSON_DEPTH = 32
LINKB_MAX_SESSION_ID_LEN = 256
LINKB_MAX_TYPE_LEN = 64
LINKB_MAX_BULK_ARRAY_LEN = 10_000
PUSH_MAX_LINE_BYTES = 1 * 1024 * 1024
# #280 主動投遞附件:單次最多帶幾個文件(防炸 Link B 幀 / 濫用);與 live MEDIA: 逐個上送不同,push 一批。
PUSH_MEDIA_MAX_FILES = 8
from e2e_keys import E2EKeyStore
from e2e_control import (
    E2EControlError,
    E2EControlVerifier,
    create_disable_receipt,
    request_digest,
    validate_disable_receipt_shape,
    verify_disable_receipt,
    visible_stable_json,
)
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
from cwd import resolve_cwd
from media import (
    MEDIA_MAX,  # noqa: F401 - 見下方 re-export 註釋:測試讀 connector.MEDIA_MAX
    extract_media_files as _media_extract,
    read_media_file as _media_read,
    resolve_media_allow_roots as _media_allow_roots,
)
from safe_log import (
    format_command_invoke_log,
    log_content,
    safe_err,
    short_id,
    text_len,
)

LINK_B_PROTO = 5  # 對齊 server（packages/protocol：B=5，#369 設備公鑰版本綁定；嚴格校驗）
LINK_B_PROTO = 5  # 對齊 server（packages/protocol：B=5，#348/#368 可靠 ACK + quiesce；嚴格校驗）
# §update 連接器發布版本:對齊 packages/protocol CONNECTOR_VERSION。⚠️ 發版必須**五處同步 bump**:
# 四連接器常量(cc/codex/openclaw 各自 src/index.ts + 這裡)+ protocol link.ts 全局。全局是 server
# 判 updateAvailable 的標尺——bump 全局漏任何一家=該家 app 永亮「更新」(本機與公開用戶一起亮,
# 重啟無用;2026-07-20 實踩);全局上生產後應儘快 sync-public 發版閉環。
CONNECTOR_VERSION = "1.5.80"

# #768 安裝目錄版本標記（對齊 TS connector-core/disk-version.ts）。
_INSTALLED_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
_CONNECTOR_VERSION_SRC_RE = re.compile(
    r'CONNECTOR_VERSION\s*=\s*["\'](\d+\.\d+\.\d+)["\']'
)


def _installed_version_mark_path() -> str:
    return os.path.join(STATE_DIR, "installed-version-hermes")


def _note_installed_version_on_disk(version: str) -> None:
    """installer 退出 0 後寫入；health 用它判 pendingRestart。"""
    if not _INSTALLED_VERSION_RE.match(version):
        return
    path = _installed_version_mark_path()
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(version + "\n")
        os.replace(tmp, path)
    except OSError:
        pass


def _read_disk_connector_version() -> str | None:
    path = _installed_version_mark_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = (fh.read() or "").strip().split()[0]
        if _INSTALLED_VERSION_RE.match(raw):
            return raw
    except OSError:
        pass
    # 兜底：安裝樹 connector.py 內的 CONNECTOR_VERSION 常量
    app = os.path.join(STATE_DIR, "app", "connector.py")
    try:
        with open(app, "r", encoding="utf-8") as fh:
            m = _CONNECTOR_VERSION_SRC_RE.search(fh.read())
        if m and _INSTALLED_VERSION_RE.match(m.group(1)):
            return m.group(1)
    except OSError:
        pass
    return None


def _report_installed_version(process_version: str) -> str:
    """進程版 vs 磁盤版取較新者（磁盤 > 進程 = 待重啟）。"""
    disk = _read_disk_connector_version()
    if not disk:
        return process_version
    # 簡易 semver 比較（與 assert_self_update_allowed 同嚴格三元組）
    def parts(v: str) -> tuple[int, int, int]:
        a, b, c = v.split(".")
        return int(a), int(b), int(c)

    try:
        if parts(process_version) < parts(disk):
            return disk
    except (TypeError, ValueError):
        pass
    return process_version
E2E_APPROVAL_PLAINTEXT_MAX = 64 * 1024
# #273 加密 clarify/secret 的待決快照上限。真實併發遠低於此（一次回合最多幾條問題）；
# 只是給「用戶從不回答」這條路徑封頂，別讓常駐進程無限攢。
E2E_INTERACTIVE_PENDING_MAX = 256
# #279 E2E prompt 解密失敗的用戶可見回執(僅提示語,零內容洩漏;四連接器同文案)。
E2E_DECRYPT_FAIL_WARNING = "無法解密這條消息(設備與連接器的加密密鑰可能失步)——請重試,或重新關閉再開啟本會話的端到端加密。"
_UUID_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _same_local_uuid(a: str, b: str) -> bool:
    return bool(_UUID_ID_RE.fullmatch(a) and _UUID_ID_RE.fullmatch(b) and a.lower() == b.lower())


_SAFE_INSTALLER_ENV = {
    "HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "TMP", "TEMP", "SHELL", "TERM",
    "LANG", "LANGUAGE", "TZ",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "CURL_CA_BUNDLE", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "BUN_INSTALL",
    "HERMES_HOME", "HERMES_PYTHON",
    "MACCHIATO_STATE_DIR", "MACCHIATO_HERMES_PROFILE",
    "MACCHIATO_SERVER_URL", "MACCHIATO_WEB_URL", "MACCHIATO_MIRROR",
    "MACCHIATO_CLAUDE_BIN", "MACCHIATO_CODEX_BIN",
    # #767 服务由外部托管（system unit / 容器 / 一体机镜像）：不进白名单 = self_update 拉起的
    # installer 收不到它，照样去装 user unit —— 更新写进磁盘、真正在跑的进程纹丝不动，
    # 用户点 Update 永远失败。
    "MACCHIATO_SKIP_UNIT",
}


# #773 installer 退出 0 之後再等這麼久;到點本進程還活着 ＝ 重啟沒把它換掉 → 放開交棒閂。
# 與 TS 三家單源同義(packages/connector-core/src/selfupdate.ts 的 SELF_UPDATE_RESTART_GRACE_MS,
# 那裡有完整理由):下界要大到「真重啟必然已經把本進程殺掉」(systemd 的 restart 是阻塞的,
# installer 退出時舊進程早已死透;launchd 的 kickstart -k 也是秒級),上界要明顯小於 app 側
# 90s 的更新看門狗,用戶那一下「重試」才真的能再裝一次。env 只為測試提供注入點。
_SELF_UPDATE_RESTART_GRACE_S = (
    float(os.environ.get("MACCHIATO_SELF_UPDATE_RESTART_GRACE_MS") or 45000) / 1000
)


def _build_installer_env(source: dict[str, str], manifest_path: str) -> dict[str, str]:
    """只传安装所需环境；测试信任根、loader/runtime/shell hook 默认全部丢弃。"""
    env = {
        key: value
        for key, value in source.items()
        if key in _SAFE_INSTALLER_ENV or key.startswith("LC_")
    }
    env["MACCHIATO_ONLY"] = "hermes"
    env["MACCHIATO_MANIFEST"] = manifest_path
    return env


IMPORT_BATCH = 20
# §15 全渠道持續鏡像（tail state.db）——默認常開;#308 MACCHIATO_MIRROR=off 可停(見 MIRROR_OFF)。
MIRROR_POLL_S = float(os.environ.get("MACCHIATO_MIRROR_POLL_S", "2"))  # 輪詢間隔（小=更即時、多步回合更增量）
# F-01 / #348 durable outbox：未 ACK 批按此間隔重發（對齊 CC/Codex 15s），避免每 2s 刷 server。
MIRROR_RESEND_S = float(os.environ.get("MACCHIATO_MIRROR_RESEND_S", "15"))
# #308 MACCHIATO_MIRROR=off:停鏡像輪詢+首裝自動導入(終端側活動不進 app)。⚠️ 只停這兩樣——
# driven 會話路徑/dedup 衛生照常;_mirror_last_run 恆 None → 看門狗與 server staleness 天然跳過。
MIRROR_OFF = os.environ.get("MACCHIATO_MIRROR", "").lower() in ("off", "0", "false", "no")
# #309 多 profile 實例:
#  - HERMES_HOME → 目標 hermes profile 的 home(默認 ~/.hermes;hermes 自家 get_hermes_home()
#    讀同一 env,且 gateway 子進程繼承本進程 env → state.db/config/skills 整條鏈跟隨);
#  - MACCHIATO_STATE_DIR → 本連接器每實例文件的根(默認 ~/.macchiato,單實例零遷移;
#    profile 實例由 install.sh 指到 ~/.macchiato/hermes-<profile>,兩實例互不打架)。
STATE_DIR = os.path.expanduser(os.environ.get("MACCHIATO_STATE_DIR", "").strip() or "~/.macchiato")


def _hermes_home() -> str:
    return os.path.expanduser(os.environ.get("HERMES_HOME", "").strip() or "~/.hermes")


def _default_push_sock() -> str:
    """#309 push socket 的零配置推導——插件跑在 profile 的 gateway 進程裡,看不到
    MACCHIATO_STATE_DIR,雙方只共享 hermes home 這一個事實,故從它推導:
    非默認 profile → <HERMES_HOME>/macchiato-push.sock;默認 → ~/.macchiato/push.sock
    (與單實例時代 bit 級一致,零遷移)。⚠️ 插件側 services/hermes-plugin/macchiato/adapter.py
    同一規則,改動必須兩邊同步。"""
    hh = _hermes_home()
    if os.path.realpath(hh) != os.path.realpath(os.path.expanduser("~/.hermes")):
        return os.path.join(hh, "macchiato-push.sock")
    return os.path.expanduser("~/.macchiato/push.sock")


def _cred_path() -> str:
    """配對憑證路徑(pair.py 寫入;_main 回落讀取、#387 解綁隔離同一規則)。"""
    return os.path.expanduser(os.environ.get("MACCHIATO_CRED") or os.path.join(STATE_DIR, "connector.json"))


def _quarantine_creds() -> None:
    """#387 app 解綁後隔離憑證:改名 .revoked(留痕)。重啟後 _main 見標記退 78,不再空轉;
    重跑安裝命令即重新配對。盡力而為(env 直供 token 時無檔可隔離)。"""
    p = _cred_path()
    try:
        if os.path.exists(p):
            os.replace(p, p + ".revoked")
    except OSError:
        pass


MIRROR_STATE = os.path.join(STATE_DIR, "mirror.json")  # 鏡像水位線持久化
PROJ_MEM_MAX = 256 * 1024  # #227 AGENTS.md 上限
PROJ_SHIM = "@AGENTS.md\n"  # #227 CLAUDE.md 墊片


def _projects_reg_path() -> str:
    return os.environ.get("MACCHIATO_HERMES_PROJECTS") or os.path.join(STATE_DIR, "hermes-projects.json")


def _mem_hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


# ── #378 抗 symlink / TOCTOU 的「具名文件」讀寫原語（Projects 的 AGENTS.md/CLAUDE.md 專用）─────
# 威脅：mem 只允許具名 AGENTS.md/CLAUDE.md，但舊實現讀跟隨 symlink（可讀 ~/.ssh/id_rsa）、寫用固定
# `<file>.tmp`（跟隨預置 symlink 再 rename 覆寫任意文件）、目錄可在備案後被換成 symlink（TOCTOU）。
# 對策：目錄 realpath+dev/ino 釘身份、每次操作前重驗；**符號連結不一律拒,而是「安全解析 + 包含性檢查」**
# （2026-07-25 人類 review 定調:用 dotfiles symlink 管 CLAUDE.md 的用戶必須能正常用）——realpath 解析後
# 斷言目標仍在備案目錄樹內,越界則拒；對解析後的真實路徑 O_NOFOLLOW 打開 + fstat 校驗（常規文件、非硬
# 連結、dev/ino 與解析時一致）；讀先量後配限尺寸；寫**寫穿到解析後的真實路徑**（保住 symlink 不被替換）,
# 走隨機臨時名 O_EXCL|O_NOFOLLOW+0600、replace 前重驗目錄身份。與 TS 側 safe-fs.ts 逐條對齊。
# 侷限（如實記錄）：Python 無便捷 openat/dirfd,項目樹內部的中間路徑段仍有殘留 TOCTOU 窗口（收窄而非
# 消滅）；硬連結靠 nlink==1 擋讀,但 nlink 恰為 1（原文件已刪）時與普通文件無異——擋不住就是擋不住。
def _proj_dir_identity(path: str) -> dict:
    canon = os.path.realpath(os.path.expanduser(path))
    st = os.stat(canon)
    if not stat.S_ISDIR(st.st_mode):
        raise ValueError(f"不是目錄:{canon}")
    return {"canon": canon, "dev": st.st_dev, "ino": st.st_ino}


def _proj_assert_dir(identity: dict) -> None:
    ls = os.lstat(identity["canon"])
    if stat.S_ISLNK(ls.st_mode):
        raise ValueError(f"拒絕:可信目錄被換成符號連結({identity['canon']})")
    st = os.stat(identity["canon"])
    if not stat.S_ISDIR(st.st_mode) or st.st_dev != identity["dev"] or st.st_ino != identity["ino"]:
        raise ValueError(f"拒絕:可信目錄身份已變({identity['canon']})")


def _proj_within_dir(root: str, target: str) -> bool:
    """target 是否在 root **之內**(邊界安全:防 /a/bc 誤判在 /a/b 內;root 自身不算內)。"""
    return target.startswith(root.rstrip(os.sep) + os.sep)


def _proj_resolve_named(identity: dict, name: str):
    """安全解析備案目錄下的具名項:不存在 → None;符號連結 → realpath 解析並**斷言目標仍在備案目錄樹內**
    (越界 / 斷鏈拋錯)。回 dict(path/via_symlink/is_file/dev/ino),path 之末段在解析那一刻確定非符號連結。"""
    _proj_assert_dir(identity)
    entry = os.path.join(identity["canon"], name)
    try:
        ls = os.lstat(entry)
    except FileNotFoundError:
        return None
    if not stat.S_ISLNK(ls.st_mode):
        return {"path": entry, "via_symlink": False, "is_file": stat.S_ISREG(ls.st_mode),
                "dev": ls.st_dev, "ino": ls.st_ino}
    target = os.path.realpath(entry)
    if not os.path.exists(target):
        raise ValueError(f"拒絕:{name} 是斷開的符號連結(目標不可解析)")
    # 包含性檢查:目標必須仍在**本 project 備案目錄樹內**——項目內的軟連結照用,指到項目外
    # (~/.ssh/id_rsa、別人的倉庫…)就是真越界,拒。
    if not _proj_within_dir(identity["canon"], target):
        raise ValueError(f"拒絕:{name} 的符號連結目標在項目目錄外({target})")
    ts = os.lstat(target)  # realpath 之後末段必非 symlink;取指紋供 open 後比對
    return {"path": target, "via_symlink": True, "is_file": stat.S_ISREG(ts.st_mode),
            "dev": ts.st_dev, "ino": ts.st_ino}


def _proj_open_verified(r: dict, name: str):
    """按解析結果打開並校驗:O_NOFOLLOW(末段被換成 symlink → ELOOP)+ fstat(常規文件、非硬連結、
    dev/ino 與解析時一致)。解析後文件被刪 → None。"""
    try:
        fd = os.open(r["path"], os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    except OSError as e:
        if e.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)):
            raise ValueError(f"拒絕讀取:{name} 在校驗與打開之間被換成符號連結")
        raise
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError(f"拒絕讀取:{name} 不是常規文件")
        if st.st_nlink != 1:
            raise ValueError(f"拒絕讀取:{name} 是硬連結(nlink={st.st_nlink})")
        if st.st_dev != r["dev"] or st.st_ino != r["ino"]:
            raise ValueError(f"拒絕讀取:{name} 在校驗與打開之間被替換")
    except Exception:
        os.close(fd)
        raise
    return fd


def _proj_read_named(identity: dict, name: str, max_bytes: int):
    r = _proj_resolve_named(identity, name)
    if r is None:
        return None
    fd = _proj_open_verified(r, name)
    if fd is None:
        return None
    try:
        size = min(os.fstat(fd).st_size, max_bytes)  # #378 先量後配
        data = b""
        while len(data) < size:
            chunk = os.read(fd, size - len(data))
            if not chunk:
                break
            data += chunk
        return data.decode("utf-8", errors="replace")
    finally:
        os.close(fd)


def _proj_named_size(identity: dict, name: str):
    """具名文件的字節大小(同讀路徑的安全性);不存在 → None。
    用途:「超限就整體拒絕」的場景——絕不能先讀出**截斷版**再落盤(遷移場景會把超出部分永久丟)。"""
    r = _proj_resolve_named(identity, name)
    if r is None:
        return None
    fd = _proj_open_verified(r, name)
    if fd is None:
        return None
    try:
        return os.fstat(fd).st_size
    finally:
        os.close(fd)


def _proj_named_kind(identity: dict, name: str) -> str:
    """具名項的可用形態(符號連結安全解析後判定):absent / file / other。越界 symlink 拋錯。"""
    r = _proj_resolve_named(identity, name)
    if r is None:
        return "absent"
    return "file" if r["is_file"] else "other"


def _proj_write_named(identity: dict, name: str, content: str) -> None:
    """原子寫:**寫穿到解析後的真實路徑**(項目內的 symlink 因此保留,dotfiles 照用),
    走該目錄下的隨機臨時名 + O_EXCL|O_NOFOLLOW + 0600,replace 前再驗目錄身份。"""
    r = _proj_resolve_named(identity, name)  # 內含 _proj_assert_dir;越界 symlink 在此就拒
    if r is not None and not r["is_file"]:
        raise ValueError(f"拒絕寫入:{name} 不是常規文件")
    target = r["path"] if r is not None else os.path.join(identity["canon"], name)
    base = os.path.basename(target)
    parent_path = os.path.dirname(target)
    # 目標所在目錄同樣釘身份:replace 前重驗,擋「解析後把中間目錄換掉」的 TOCTOU。
    parent = identity if parent_path == identity["canon"] else _proj_dir_identity(parent_path)
    if parent is not identity and not _proj_within_dir(identity["canon"], parent["canon"]):
        raise ValueError(f"拒絕寫入({name}):目標目錄在項目目錄外({parent['canon']})")
    tmp = os.path.join(parent["canon"], f".{base}.{os.urandom(9).hex()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    renamed = False
    try:
        try:
            data = content.encode("utf-8")
            off = 0
            while off < len(data):
                off += os.write(fd, data[off:])
        finally:
            os.close(fd)
        _proj_assert_dir(identity)
        if parent is not identity:
            _proj_assert_dir(parent)
        os.replace(tmp, os.path.join(parent["canon"], base))
        renamed = True
    finally:
        # 寫失敗(盤滿 / IO 錯)也要清臨時文件——否則備案目錄裡越積越多 `.AGENTS.md.<rand>.tmp`
        # 殘骸。對齊 TS 側 safe-fs.ts 的 finally 清理。
        if not renamed:
            try:
                os.unlink(tmp)
            except OSError:
                pass


MIRROR_PRUNE_S = float(os.environ.get("MACCHIATO_MIRROR_PRUNE_S", str(30 * 24 * 3600)))  # #9 水位線閒置多久可裁
# 自驅會話 id 映射持久化：server sid（ULID）→ state.db 會話 id（gateway session_key）。
# Hermes 0.18+ 的 create_session 返回 stored_session_id = state.db 行 id ≠ 運行時句柄；
# 沒有這張表，自驅會話的 E2E 加密鏡像投遞 / 重啟後帶上下文續聊 / 歸檔回寫都對不上號。
SESSIONS_MAP = os.path.join(STATE_DIR, "sessions.json")
ATTACH_DIR = os.path.join(STATE_DIR, "attachments")  # 入站附件落地（gateway 同機可讀）
HEALTH_FILE = os.path.join(STATE_DIR, "health.json")  # 本地健康快照（可本機 inspect，0.12.0 起就在；路徑保持不動）
# #669 supervisor 讀的是**按 kind 分家**的那份：`~/.macchiato` 是四家共用的狀態根
# （`<kind>-connector.json`、`supervise-<kind>.state` 早就按 kind 分了），共用一個 health.json
# 會讓同機的 CC/Codex/Hermes 互相覆蓋 → 「A 的 supervisor 讀到 B 的斷連狀態並重裝 A」。
# 內容與 HEALTH_FILE 逐字相同，只是名字不撞。
HEALTH_FILE_KIND = os.path.join(STATE_DIR, "health-hermes.json")
# #669 本機安裝的穩定標識：分批放量的哈希種子。生成後持久化，不隨進程/重裝變。
# 與 TS 三家的 `packages/connector-core/src/identity.ts#installIdPath` 同路徑同語義。
INSTALL_ID_FILE = os.path.join(STATE_DIR, "install-id")
PUSH_SOCK = os.path.expanduser(os.environ.get("MACCHIATO_PUSH_SOCK") or _default_push_sock())  # §17 主動投遞：Hermes macchiato 插件 → 連接器(#309 profile 實例自動走 per-profile sock)
HEALTH_INTERVAL_S = float(os.environ.get("MACCHIATO_HEALTH_S", "30"))
ATTACH_TTL_S = float(os.environ.get("MACCHIATO_ATTACH_TTL_S", str(6 * 3600)))  # 入站附件保留 6h 後 GC
MIRROR_STUCK_S = float(os.environ.get("MACCHIATO_MIRROR_STUCK_S", "60"))  # 鏡像輪詢時延超此→判卡死、重啟
# §19 quiesce 自旋上限。必須**小於** server 的等待上限(默認 300s),否則 server 先超時、連接器還
# 攥著屏障不放 → 兩側狀態機錯位。對齊 OpenClaw 的 4 分鐘。
QUIESCE_TIMEOUT_S = float(os.environ.get("MACCHIATO_QUIESCE_TIMEOUT_S", "240"))


_INSTALL_ID_RE = re.compile(r"^[0-9a-zA-Z._-]{8,128}$")


def _read_or_create_install_id(path: str | None = None) -> str:
    """#669 讀取（必要時生成）本機安裝標識。與 TS 側 `heartbeat.ts` 逐字同語義。

    併發安全用 ``O_CREAT|O_EXCL`` 搶佔式創建——同機四家連接器同時啟動時只有一個贏，輸的那個
    回頭讀贏家寫的值。**絕不用 write-then-rename**：那會讓後到的進程覆蓋先到的 id，
    於是「穩定標識」每次重啟都在兩個值之間跳，分批放量的分桶跟著抖。
    """
    p = path or INSTALL_ID_FILE

    def _read() -> str | None:
        try:
            with open(p, encoding="utf-8") as f:
                s = f.read().strip()
            return s if _INSTALL_ID_RE.match(s) else None
        except OSError:
            return None

    existing = _read()
    if existing:
        return existing
    fresh = str(uuid.uuid4())
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.write(fd, (fresh + "\n").encode("utf-8"))
        finally:
            os.close(fd)
        return fresh
    except OSError:
        # 已存在（別人搶先）或盤寫不了：能讀到就用讀到的，否則退回本進程臨時值。
        # fail-open——心跳寫不出去絕不能把連接器搞崩。
        return _read() or fresh


def _sanitize_filename(name: str) -> str:
    name = os.path.basename(name or "").strip()
    name = re.sub(r"[^\w.\-]+", "_", name)
    return name[:120] or "attachment"


DOWNLOAD_MAX = 100 * 1024 * 1024  # 入站附件下載封頂（100MB），超出即中止（防無界寫盤）
# #383 全局 attach root 總字節配額(默認 2 GiB)+並發下載上限(默認 3)
ATTACH_QUOTA_BYTES = int(os.environ.get("MACCHIATO_ATTACH_QUOTA_BYTES", str(2 * 1024 * 1024 * 1024)))
ATTACH_MAX_INFLIGHT = int(os.environ.get("MACCHIATO_ATTACH_MAX_INFLIGHT", "3"))
_PART_STALE_S = 15 * 60  # 崩潰殘留 .part 超過此時長才由 GC 清(須 > 下載超時)
_ATTACH_INFLIGHT = 0
_ATTACH_INFLIGHT_LOCK = threading.Lock()
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)


def _ensure_private_dir(path: str) -> None:
    """attachment 目錄 0700(exist_ok + chmod 兜底)。"""
    os.makedirs(path, mode=0o700, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _du_attach_root(root: str | None = None) -> int:
    """統計 attach root 佔用(lstat,不跟隨 symlink;只計常規文件)。"""
    root = root if root is not None else ATTACH_DIR
    total = 0
    try:
        entries = os.listdir(root)
    except OSError:
        return 0
    for id_name in entries:
        d = os.path.join(root, id_name)
        try:
            st = os.lstat(d)
        except OSError:
            continue
        if stat.S_ISLNK(st.st_mode):
            continue
        if stat.S_ISREG(st.st_mode):
            total += st.st_size
            continue
        if not stat.S_ISDIR(st.st_mode):
            continue
        try:
            files = os.listdir(d)
        except OSError:
            continue
        for f in files:
            p = os.path.join(d, f)
            try:
                fs = os.lstat(p)
                if stat.S_ISREG(fs.st_mode):
                    total += fs.st_size
            except OSError:
                pass
    return total


# #917 SSRF 目標網段——**與 TS 三家的 `connector-core/attachments/ssrf.ts:isPrivateIp` 逐格對齊**。
#
# 事故：Hermes 這份用的是 `ipaddress` 的 `is_private or is_reserved or …`，比 TS 那份嚴得多——
# Python 的 `is_private` 把 IANA 特殊用途段也算進去，其中 `198.18.0.0/15` 正是 Surge / Clash /
# Shadowrocket 這類代理 **fake-ip 模式的默認映射段**。用戶（或其網關）開着代理時，
# `fly.storage.tigris.dev` 被解析成 `198.18.x.x`（真實公網地址另有其人），於是 Hermes 對
# **每一個附件**都在發出請求之前就自我拒絕：用戶只看到「⚠️ 附件下載失敗」，文件從未落過盤，
# 而同機的 CC/Codex/OpenClaw 一切正常——因為 TS 那份不拒這一段。四家同構的安全原語必須真同構。
#
# fake-ip 不是「內網主機」：連上去的是代理自己，代理再按**原域名**出網；TLS 依舊拿域名做
# SNI/證書校驗（見 `_open_validated_download`），一格都沒鬆。故域名解析落到這裡放行。
#
# **但 url 直接寫 IP 字面量時仍按最嚴判**（`strict=True`）：那是「有人指名要連這個地址」，
# 與「用戶的 DNS 把域名映射到了代理」是兩回事，沒有任何正當理由，照拒。
_SSRF_V4_NETS = tuple(
    ipaddress.ip_network(c)
    for c in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "127.0.0.0/8",
        "100.64.0.0/10",  # CGNAT
        "169.254.0.0/16",  # link-local / 雲元數據
        "172.16.0.0/12",
        "192.168.0.0/16",
        "224.0.0.0/3",  # multicast + 高位保留（含 255.255.255.255）
    )
)
_SSRF_V6_NETS = tuple(
    ipaddress.ip_network(c) for c in ("::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8")
)


def _parse_ip(value: str):
    """解析 IP（去掉 IPv6 scope id、v4-mapped 剝殼）；解析不了回 None。"""
    try:
        addr = ipaddress.ip_address(str(value).strip("[]").split("%", 1)[0])
    except ValueError:
        return None
    return getattr(addr, "ipv4_mapped", None) or addr


def _is_ssrf_target(ip: str, *, strict: bool = False) -> bool:
    """解析不了 → 按危險處理（同 TS）。

    `strict`：url 的 host 本身就是 IP 字面量時用——連 IANA 保留/特殊用途段一起拒，
    不給 fake-ip 段開的那道門（那道門只為「域名被代理解析成 fake-ip」而開）。
    """
    addr = _parse_ip(ip)
    if addr is None:
        return True
    if strict and (addr.is_private or addr.is_reserved or addr.is_multicast or addr.is_link_local):
        return True
    nets = _SSRF_V4_NETS if addr.version == 4 else _SSRF_V6_NETS
    return any(addr in n for n in nets)


def _scrub_reason(exc: BaseException) -> str:
    """#917 給用戶看的失敗原因:一句話、不帶簽名 URL（那行會落進聊天記錄）、封頂 120 字。"""
    msg = str(exc).strip() or type(exc).__name__
    msg = re.sub(r"https?://\S+", "<url>", msg)  # 簽名 URL 絕不進聊天記錄（#381 同理）
    msg = " ".join(msg.split())
    return msg[:120]


def _is_allowed_local_http(p) -> bool:
    """#379:僅顯式 dev 開關才放行 http→loopback（對齊 server dev-disk 的 /attachments/raw@8080）。

    env:
      MACCHIATO_ATTACH_ALLOW_LOCALHOST=1  必填，否則一律拒 loopback
      MACCHIATO_ATTACH_LOCAL_PORT         可選，默認 8080
      MACCHIATO_ATTACH_LOCAL_PATH_PREFIX  可選，默認 /attachments；空字串=不限 path
    """
    if os.environ.get("MACCHIATO_ATTACH_ALLOW_LOCALHOST") != "1":
        return False
    if p.scheme != "http":
        return False
    host = (p.hostname or "").lower()
    if host not in _LOCAL_HOSTS:
        return False
    # userinfo 混淆（http://evil@127.0.0.1/…）一律拒
    if p.username is not None or p.password is not None:
        return False
    port_raw = os.environ.get("MACCHIATO_ATTACH_LOCAL_PORT")
    if port_raw is None or port_raw == "":
        want_port = 8080
    else:
        try:
            want_port = int(port_raw)
        except ValueError:
            return False
    if not (1 <= want_port <= 65535):
        return False
    got_port = p.port if p.port is not None else 80  # http 默認 80；dev-disk 是 8080
    if got_port != want_port:
        return False
    if "MACCHIATO_ATTACH_LOCAL_PATH_PREFIX" in os.environ:
        prefix = os.environ["MACCHIATO_ATTACH_LOCAL_PATH_PREFIX"]
    else:
        prefix = "/attachments"
    if prefix:
        path = p.path or "/"
        if path != prefix and not path.startswith(prefix if prefix.endswith("/") else prefix + "/"):
            return False
    return True


def _validate_download_url(url: str) -> None:
    """SSRF / 本地文件防護（審計 #12；#379 收緊）：server 下發的 url 直喂 urllib 會被 file://
    讀本機密鑰、或指向內網/雲元數據做 SSRF（萬一 server 被攻破 / 明文 MITM）。只允許 https；
    生產默認**拒** loopback。本地 dev-disk 須顯式 MACCHIATO_ATTACH_ALLOW_LOCALHOST=1 才放行
    http→loopback；拒 file/ftp/data/gopher；https 目標解析後不得落在私網/環回/link-local/保留段。"""
    p = urlparse(url)
    if _is_allowed_local_http(p):
        return  # #379 顯式 dev 才放行
    if p.scheme != "https":
        raise ValueError(
            f"不允許的 url scheme：{p.scheme!r}（只允許 https；"
            "本地 dev-disk 需 MACCHIATO_ATTACH_ALLOW_LOCALHOST=1）"
        )
    host = (p.hostname or "").lower()
    if not host:
        raise ValueError("url 缺主機名")
    if p.username is not None or p.password is not None:
        raise ValueError("url 不得含 userinfo（防混淆）")
    try:
        infos = socket.getaddrinfo(host, p.port or 443, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise ValueError(f"解析主機失敗：{exc}")
    literal = _parse_ip(host) is not None   # host 是 IP 字面量 → 按最嚴判（#917）
    for info in infos:
        if _is_ssrf_target(info[4][0], strict=literal):
            raise ValueError(f"目標 IP {info[4][0]} 在私網/環回/保留範圍（防 SSRF）")


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
    if _is_allowed_local_http(p):
        conn = http.client.HTTPConnection(host, p.port or 80, timeout=timeout)
        conn.request("GET", path, headers=headers)
        resp = conn.getresponse()
    else:
        if p.scheme != "https":
            raise ValueError(
                f"不允許的 scheme：{p.scheme!r}（只允許 https；"
                "本地 dev-disk 需 MACCHIATO_ATTACH_ALLOW_LOCALHOST=1）"
            )
        if not host:
            raise ValueError("url 缺主機名")
        if p.username is not None or p.password is not None:
            raise ValueError("url 不得含 userinfo（防混淆）")
        port = p.port or 443
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        literal = _parse_ip(host) is not None   # 同上：IP 字面量不吃 fake-ip 那道門
        ips = []
        for info in infos:
            if _is_ssrf_target(info[4][0], strict=literal):
                raise ValueError(f"目標 IP {info[4][0]} 在私網/環回/保留範圍（防 SSRF DNS-rebinding）")
            if info[4][0] not in ips:
                ips.append(info[4][0])
        if not ips:
            raise ValueError("解析無可用地址")
        # #917 逐個試,不是只試第一個。getaddrinfo 在雙棧配置下常把 AAAA 排在前面,而不少
        # 機器（容器 / 沒有 v6 路由的 VPS）連上去就是 ENETUNREACH——只認第一條 = 該機所有附件
        # 永遠下載失敗。urllib 的老路徑本來會逐個回落,#249 改成 pin-IP 時把這個能力丟了。
        raw = None
        last_err = None
        for ip in ips:
            try:
                raw = socket.create_connection((ip, port), timeout=timeout)  # 連校驗過的 IP（pin）
                break
            except OSError as exc:
                last_err = exc
        if raw is None:
            raise ValueError(f"連接失敗（已試 {len(ips)} 個地址）：{last_err}")
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
    """下載 presigned GET url 到本地文件（連接器與 gateway 同機，落盤即可讓 gateway 讀）。
    #383:0700/0600;O_EXCL|O_NOFOLLOW 臨時寫 + 原子 replace;Content-Length 早拒;
    全局配額 + 並發上限;失敗 finally unlink partial。"""
    global _ATTACH_INFLIGHT
    _validate_download_url(str(ref.get("url") or ""))  # 審計 #12：下載前早拒（file:// / 字面私網）

    with _ATTACH_INFLIGHT_LOCK:
        if _ATTACH_INFLIGHT >= ATTACH_MAX_INFLIGHT:
            raise ValueError(f"附件並發下載達上限 {ATTACH_MAX_INFLIGHT}")
        _ATTACH_INFLIGHT += 1

    name = _sanitize_filename(ref.get("name") or "")
    if "." not in name:
        ext = mimetypes.guess_extension((ref.get("mime") or "").split(";")[0].strip()) or ""
        name += ext
    d = os.path.join(ATTACH_DIR, re.sub(r"[^\w\-]+", "_", str(ref.get("id") or "att")))
    path = os.path.join(d, name)
    tmp = os.path.join(d, f".{name}.{os.urandom(8).hex()}.part")
    published = False
    try:
        _ensure_private_dir(ATTACH_DIR)
        _ensure_private_dir(d)

        used = _du_attach_root(ATTACH_DIR)
        if used >= ATTACH_QUOTA_BYTES:
            raise ValueError(f"附件磁盤配額已滿 {used}/{ATTACH_QUOTA_BYTES} 字節")

        # #249 pin-IP + 拒重定向
        with _open_validated_download(str(ref["url"])) as r:
            # Content-Length 早拒:帶頭且超 DOWNLOAD_MAX / 配額 → 不寫盤
            cl_raw = r.getheader("Content-Length")
            if cl_raw is not None and cl_raw != "":
                try:
                    cl = int(cl_raw)
                except ValueError:
                    cl = -1
                if cl >= 0:
                    if cl > DOWNLOAD_MAX:
                        raise ValueError(f"Content-Length {cl} 超過上限 {DOWNLOAD_MAX}")
                    if used + cl > ATTACH_QUOTA_BYTES:
                        raise ValueError(f"附件將超過磁盤配額 {used}+{cl}/{ATTACH_QUOTA_BYTES}")

            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _O_NOFOLLOW, 0o600)
            written = 0
            try:
                with os.fdopen(fd, "wb") as f:
                    fd = -1  # 所有權交給 fdopen
                    while True:
                        chunk = r.read(1 << 16)
                        if not chunk:
                            break
                        written += len(chunk)
                        if written > DOWNLOAD_MAX:
                            raise ValueError(f"下載超過上限 {DOWNLOAD_MAX} 字節，已中止")
                        f.write(chunk)
            except Exception:
                if fd >= 0:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                raise
        os.replace(tmp, path)
        published = True
        return path
    finally:
        with _ATTACH_INFLIGHT_LOCK:
            _ATTACH_INFLIGHT = max(0, _ATTACH_INFLIGHT - 1)
        if not published:
            try:
                os.unlink(tmp)
            except OSError:
                pass


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


# #372 出站附件 capability-bound 路徑校驗(見 media.py);MEDIA_MAX 自 media re-export 給測試。


def _extract_media_files(text: str, allowed_roots: list | None = None) -> list:
    """#158/#372:僅 MEDIA: 標記 + 允許根內路徑(不再合併裸絕對路徑自動上傳)。"""
    roots = allowed_roots if allowed_roots is not None else _media_allow_roots(
        state_dir=STATE_DIR, attach_dir=ATTACH_DIR
    )
    return _media_extract(text, roots)


def _read_media_file(path: str, allowed_roots: list | None = None) -> dict | None:
    """#158/#372:讀文件成 media.attach payload;根外/超限/非常規 → None。"""
    roots = allowed_roots if allowed_roots is not None else _media_allow_roots(
        state_dir=STATE_DIR, attach_dir=ATTACH_DIR
    )
    return _media_read(path, roots)


def _gc_attachments() -> int:
    """刪除 ATTACH_DIR 下超過 ATTACH_TTL_S 的入站附件（prompt 早已消費，無需長留）。
    #383:lstat 不跟隨 symlink;清 symlink/未知/過期 `.part` 殘留;目錄保持 0700。"""
    import shutil

    now = time.time()
    removed = 0
    try:
        os.chmod(ATTACH_DIR, 0o700)
    except OSError:
        pass
    try:
        top = os.listdir(ATTACH_DIR)
    except (FileNotFoundError, OSError):
        return 0
    for id_name in top:
        d = os.path.join(ATTACH_DIR, id_name)
        try:
            st = os.lstat(d)
        except OSError:
            continue
        # 根下 symlink / 非目錄雜物:不跟隨,直接清
        if stat.S_ISLNK(st.st_mode):
            try:
                os.unlink(d)
                removed += 1
            except OSError:
                pass
            continue
        if not stat.S_ISDIR(st.st_mode):
            try:
                os.unlink(d)
                removed += 1
            except OSError:
                pass
            continue
        try:
            os.chmod(d, 0o700)
        except OSError:
            pass
        try:
            files = os.listdir(d)
        except OSError:
            continue
        for name in files:
            p = os.path.join(d, name)
            try:
                fs = os.lstat(p)
            except OSError:
                continue
            try:
                if stat.S_ISLNK(fs.st_mode):
                    os.unlink(p)
                    removed += 1
                    continue
                if not stat.S_ISREG(fs.st_mode):
                    if stat.S_ISDIR(fs.st_mode):
                        shutil.rmtree(p, ignore_errors=True)
                    else:
                        os.unlink(p)
                    removed += 1
                    continue
                is_part = name.startswith(".") and name.endswith(".part")
                age = now - fs.st_mtime
                if (is_part and age > _PART_STALE_S) or (not is_part and age > ATTACH_TTL_S):
                    os.unlink(p)
                    removed += 1
            except OSError:
                pass
        try:
            if not os.listdir(d):
                os.rmdir(d)
        except OSError:
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
        # #601 server_sid → 這個會話在 state.db 裡的 id（運行時，_ensure_session 解析出來就記）。
        # 與持久的 `_stored` 分工：`_stored` 只存**自驅**會話那份「server_sid ≠ state.db id」的映射
        # （鏡像靠 `_stored_rev` 據此跳過 live 獨佔的會話）；而鏡像來源的會話（Discord/終端起的，
        # server_sid **就是** state.db id）不能寫進 `_stored`——那會讓鏡像連它也跳過，用戶在
        # Discord/終端那邊說的話就再也進不來了。但 srcId 回填**兩種都要**，故單開這張運行時表。
        self._dbsid: dict = {}
        # #601 srcId 回填在途的 state.db 會話。Hermes 在 message.complete **之後**才把回合消息
        # 批量寫庫,回填與鏡像輪詢因此同時看見這批新行——鏡像先到就把同一條 user 行再投一遍,
        # 而 server 的 backfillDedupKey 撞唯一索引只會靜默 return false(live 行的 dedup_key
        # 永遠補不上了)。回填在途期間讓鏡像跳過該會話,把「誰先到」的競態變成確定順序。
        self._srcid_pending: set = set()
        # #656 「本端正在驅動這個會話」——**收到 prompt.submit 的那一刻**就記，而不是等
        # `_ensure_session` 把它寫進 `_fwd`。鏡像的跳過判據原本只認 `_rev/_fwd/_stored_rev`：
        #   · `_fwd/_rev` 是運行時的，要 `_ensure_session`（含一次 gateway resume 往返 + #148
        #     的 per-session 串行鏈排隊）跑完才有；
        #   · `_stored_rev` 只裝**自驅**會話——`_record_stored` 明確拒絕 `stored == server_sid`，
        #     而**鏡像來源的會話**（source=discord 等，server_sid 本身就是 state.db id）正是那種。
        # 於是「連接器起來後、某個鏡像來源會話的第一個 app 回合」有一段誰都不認的窗口：prompt 已
        # 進 gateway、user 行已落 state.db，而三張表都還沒有它 → 2s 輪詢一撞就把同一行再投一遍。
        # 生產實錄(brian@xmind.net,Libra,07-15 與 07-31)：live 行 dedup_key 全空、整個回合被複製
        # 成兩份——因為鏡像先佔了那個 src id，回合末的回填撞唯一索引只會**靜默** return false。
        # 值是過期時刻（單調鐘）：只是兜底，正常在 `_ensure_session` 寫完 `_fwd` 後即撤。
        self._driving: dict = {}
        self._sdb = None  # 懶加載的 Hermes SessionDB（session.archive 用，寫 state.db.archived）
        self._mirror_task = None  # §15 持續鏡像 tailer 任務
        self._health_task = None  # 健康上報任務
        self._push_server = None  # §17 主動投遞：本地 unix socket（Hermes macchiato 插件 → Link B）
        self._push_seq = 0
        self._started_at = time.time()
        self._linkb_state = "init"
        # #669 最近一次 link B ready 的時刻(epoch 秒);從未連上 → None。斷線後**不清零**——
        # 「上次還連著是什麼時候」正是 supervisor 判「活著但連不上」要看的東西。
        self._linkb_connected_at: float | None = None
        # #669 心跳:掛起中的非 E2E 審批(server_sid 集)。E2E 的在 _e2e_approvals 裡,兩者取並集。
        self._plain_approvals: set[str] = set()
        self._mirror_last_run = None
        self._last_error = None
        # #773 「新版已裝好、但本進程沒被換掉」的人話（**不是失敗**，見 _on_installer_exit）。
        self._self_update_notice: str | None = None
        self._compat: dict = {}
        self._smoke_err: str | None = None  # #112 解析冒煙結果(健康循環定期刷新)
        self._mirror_st = None  # 鏡像水位線狀態（nack 回退也要訪問）
        self._fresh_install = False  # #154 首裝標記(run() 起步採樣;首裝 → ready 後自動全量導入)
        self._projects: dict = {}  # #227 serverPath → canonical(本地註冊表,mem 操作硬校驗)
        self._proj_last_hash: dict = {}  # #227 canon → AGENTS.md hash(回合末比對)
        self._projects_load()
        self._mirror_batch_id = 0
        # F-01 / #348 durable outbox：進程內「上次嘗試發送」時間戳（batchId → monotonic）。
        # 落盤的 pendingMirrors 只存 frame/水位候選；節流用內存即可（重啟後立刻重發一次）。
        self._mirror_sent_at: dict = {}
        # NACK 後 lastError 黏住，直到某批真被 server ACK 才清（對齊 CC #348 errorSticky）。
        self._mirror_error_sticky = False
        # #380 斷線出站緩衝：幀數 + 總字節雙限（不再只靠 maxlen=500）。
        self._out_pending: deque[str] = deque()
        self._out_pending_bytes = 0
        self._linkb_ready = False  # #251 收到 t:"ready" 才置真:handshaking 窗口不直發未認證幀、走緩衝
        self._on_fatal = lambda: sys.exit(1)  # #246 auth_error 終端態 → 退出交 supervisor(測試可覆蓋)
        self._on_fatal_revoked = lambda: sys.exit(78)  # #387 app 解綁:EX_CONFIG,新版 unit 不再拉起(測試可覆蓋)
        self._e2e = E2EKeyStore()  # §19 per-session E2E 密鑰管理（持 K_S、封裝給設備、加解密內容）
        self._e2e_control = E2EControlVerifier(self._e2e)  # #370 设备认证控制 + 持久防重放
        # Hermes gateway 的原生 approval.respond 只有 session FIFO。E2E 下自行赋 request id +
        # digest，并严格只允许签封响应消费队首，绝不把“第二张卡的批准”错批给第一张。
        self._e2e_approvals: dict[str, deque] = {}
        # #273 加密 clarify/secret 的待決快照（request_id → {kind, serverSid, requestDigest,
        # executionRequest}）。簽封響應要拿它重算 digest 對賬，絕不信 server 傳來的元數據。
        # 有界：只在成功響應時 pop，用戶跳過/超時/會話結束都不會清——不設上限就是每條沒答的
        # 請求都留一份、常駐進程越跑越大（review #273）。超出時丟最老的（FIFO）。
        self._e2e_interactives: OrderedDict[str, dict] = OrderedDict()
        # #368 server 發出 E2E 切換前先要求 quiesce。只要 sid 在此表，新的 prompt.submit /
        # command.invoke 一律拒絕（審批/澄清/密鑰響應**不攔**——那是讓在途回合走完的幀）；
        # 既有 session chain/live/retry 收斂後才回 ACK，避免回覆跨越明密文邊界。
        self._e2e_quiescing: dict[str, tuple[str, str | None]] = {}
        # quiesce 自旋跑在後台任務裡（接收循環絕不 inline await）；持強引用防被 GC 提前回收。
        self._quiesce_tasks: set = set()
        self._mirror_lock = None  # 鏡像輪詢 ↔ E2E 歷史回灌互斥（防舊 floor 追加與整段替換競態）
        # 自驅會話持久映射（server sid ↔ state.db id）。跨進程/gateway 重啟保留——E2E 鏡像投遞、
        # resume 帶上下文、歸檔回寫都靠它。
        self._stored: dict[str, str] = self._load_stored()  # server sid -> state.db id
        self._stored_rev: dict[str, str] = {v: k for k, v in self._stored.items()}

    def configure_device_auth(self, secret, agent_link_id, authorized_devices=None, persist_authorized=None) -> None:
        """#731 注入配對 secret（薄封裝——調用方不該去摸 `_e2e` 這個私有屬性）。"""
        self._e2e.configure_device_auth(
            secret,
            agent_link_id,
            authorized_devices=authorized_devices,
            persist_authorized=persist_authorized,
        )

    async def run(self) -> None:
        loop = asyncio.get_running_loop()

        def on_event(params: dict) -> None:
            # agent → you: translate real session id back to the server's, then forward.
            real_sid = params.get("session_id")
            server_sid = self._rev.get(real_sid, real_sid)
            if self._e2e.is_protected(server_sid):
                if not self._e2e.is_e2e(server_sid):
                    print(
                        f"[E2E quarantine {server_sid}] protected session has no K_S; "
                        "local event suppressed",
                        file=sys.stderr,
                    )
                    return
                # §19 E2E:內容事件(message.*/tool.*)走加密鏡像抑制;但 #240/#273 交互事件不能一起黑洞——
                # approval/clarify/secret.request 加密後放行,媒體放行(附件不 E2E、存 server 可讀桶)。
                etype = params.get("type")
                # E2E 内容本身被抑制/镜像，但 active 生命周期仍是本地可信事实；签封
                # interrupt 靠它区分“正在运行”与会取消未来无关回合的 idle 假成功。
                if etype == "message.start":
                    self._live_inflight.add(server_sid)
                elif etype == "message.complete":
                    self._live_inflight.discard(server_sid)
                fwd = self._e2e_live_frame(server_sid, etype, params.get("payload") or {})
                if fwd is not None:
                    loop.create_task(self._to_server(server_sid, fwd))
                elif etype == "approval.request":
                    # 缺 provenance / 无法规范化 / 完整正文过大时不能给设备一张可批准的
                    # 摘要卡；本地直接 deny，避免 agent 永久挂起。
                    loop.create_task(self._deny_e2e_approval(real_sid))
                elif etype in ("clarify.request", "secret.request"):
                    # #273:無法安全加密時 skip 解掛,避免 gateway 永久等待。
                    loop.create_task(self._deny_e2e_interactive(real_sid, etype, params.get("payload") or {}))
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
            # #669 心跳:非 E2E 審批掛起追蹤(回合結束一律清——回合都完了不可能還吊着審批,
            # 這條兜底保證 pendingApproval 不會黏住成永久 true)。
            if params.get("type") == "approval.request":
                self._plain_approvals.add(server_sid)
            elif params.get("type") == "message.complete":
                self._plain_approvals.discard(server_sid)
            # 出站附件：message.complete 正文裡 MEDIA:/裸路徑標的文件 → media.attach。
            if params.get("type") == "message.complete":
                text = (params.get("payload") or {}).get("text") or ""
                if text:
                    loop.create_task(self._emit_media_from_text(server_sid, text))
                # #13:回合結束 → 回填本回合消息的源身份(state.db 行 id → live dedup_key)
                if server_sid in self._turn_floor:
                    db_sid = self._db_sid(server_sid)
                    if db_sid:
                        self._srcid_pending.add(db_sid)  # #601 回填在途,鏡像先讓一讓
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
                "e2eFailClosed": 1,
                "e2eControlAuth": 1,
                "e2eKeyVersionBinding": 1,
                "e2eDeviceAuth": 1,  # #731 配對 secret + wrap 校驗 authProof
                "e2eQuiesce": 1,
                "mirrorDurable": 1,
                "rewind": 1,  # #473 SessionDB.rewind_to_message(軟刪 active=0,原生能力)
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
                        # #380 max_size 對齊 server connectorWss（8MiB）；websockets 默認 1MiB 會
                        # 誤殺合法大鏡像/導入批，100MiB 級默認則過寬。
                        self.server_url,
                        ping_interval=20,
                        ping_timeout=float(os.environ.get("MACCHIATO_LINKB_PING_TIMEOUT", "45")),
                        close_timeout=10,
                        max_size=LINKB_MAX_FRAME_BYTES,
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

    @staticmethod
    def _outbound_session_ids(msg: dict) -> set[str]:
        ids: set[str] = set()
        for field in ("sessionId", "hermesSessionId", "chatId"):
            value = msg.get(field)
            if isinstance(value, str) and value:
                ids.add(value)
        frame = msg.get("frame")
        if isinstance(frame, dict):
            params = frame.get("params")
            if isinstance(params, dict):
                value = params.get("session_id")
                if isinstance(value, str) and value:
                    ids.add(value)
        return ids

    @staticmethod
    def _safe_e2e_mirror_session(session: object) -> bool:
        if not isinstance(session, dict) or session.get("e2e") is not True:
            return False
        messages = session.get("messages")
        if not isinstance(messages, list):
            return False
        return all(
            isinstance(message, dict)
            and isinstance(message.get("enc"), str)
            and bool(message["enc"])
            and not str(message.get("text") or "").strip()
            and not str(message.get("reasoning") or "").strip()
            and not (message.get("tools") or [])
            for message in messages
        )

    def _safe_e2e_control_result(self, msg: dict) -> bool:
        base = {
            "t",
            "agentLinkId",
            "sessionId",
            "hermesSessionId",
            "msgId",
            "ok",
        }
        ok = msg.get("ok")
        if set(msg) != (base if ok is True else base | {"error"}):
            return False
        if (
            msg.get("t") != "e2e_control_result"
            or msg.get("agentLinkId") != self.agent_link_id
            or not isinstance(msg.get("sessionId"), str)
            or not msg["sessionId"]
            or not isinstance(msg.get("hermesSessionId"), str)
            or not msg["hermesSessionId"]
            or not isinstance(msg.get("msgId"), str)
            or not msg["msgId"]
            or not isinstance(ok, bool)
        ):
            return False
        return ok is True or msg.get("error") in {
            "control_rejected",
            "side_effect_failed",
        }

    def _sanitize_protected_outbound(self, msg: dict) -> dict | None:
        """最终出站闸门：持久 protection floor 建立后，任何迟到 producer 都不能发明文。

        这不是只靠 ready 时清一次队列：一个旧 plaintext 任务可能在清队列之后才 await 到
        `_send`。因此每次发送都按当前本地 floor 重验，E2E 只放行严格密文 mirror/approval、
        key/backfill 协议和无正文 usage。
        """
        # 结果帧必须在 floor/route 判定前全局验 strict shape；否则空/伪造 sid 可绕过
        # protected intersection，异常详情也可能借 error 字段成为 server 可见侧信道。
        if msg.get("t") == "e2e_control_result":
            if self._safe_e2e_control_result(msg):
                return msg
            print("[E2E outbound dropped] invalid e2e_control_result", file=sys.stderr)
            return None
        try:
            protected = self._e2e.protected_session_ids()
        except Exception as exc:
            # keystore 已 poison/并发版本不确定时，所有可能带会话内容的出站都全局停住。
            if msg.get("t") in {
                "tui",
                "import_batch",
                "mirror_append",
                "connector_push",
                "voice_transcript",
                "message_srcid",
                "e2e_key",
                "e2e_backfill",
            }:
                print(f"[E2E outbound quarantined] {exc!r}", file=sys.stderr)
                return None
            return msg
        if not protected:
            return msg

        t = msg.get("t")
        if t in ("import_batch", "mirror_append") and isinstance(msg.get("sessions"), list):
            kept = []
            for session in msg["sessions"]:
                sid = session.get("hermesSessionId") if isinstance(session, dict) else None
                if sid not in protected:
                    kept.append(session)
                elif t == "mirror_append" and self._safe_e2e_mirror_session(session):
                    kept.append(session)
                else:
                    print(
                        f"[E2E outbound dropped] {t} plaintext/invalid protected session {sid!r}",
                        file=sys.stderr,
                    )
            if not kept and not (t == "import_batch" and msg.get("done") is True):
                return None
            return {**msg, "sessions": kept}

        if not self._outbound_session_ids(msg).intersection(protected):
            return msg
        if t in ("e2e_key", "e2e_backfill"):
            return msg
        if t == "tui":
            frame = msg.get("frame")
            params = frame.get("params") if isinstance(frame, dict) else None
            event_type = params.get("type") if isinstance(params, dict) else None
            if event_type == "turn.usage":
                return msg
            payload = params.get("payload") if isinstance(params, dict) else None
            if (
                event_type == "approval.request"
                and isinstance(payload, dict)
                and payload.get("command") == "🔒 加密審批請求"
                and payload.get("description") in (None, "")
                and isinstance(payload.get("enc"), str)
                and bool(payload["enc"])
                and isinstance(payload.get("request_id"), str)
                and bool(payload["request_id"])
                and isinstance(payload.get("request_digest"), str)
                and bool(payload["request_digest"])
            ):
                return msg
        print(
            f"[E2E outbound dropped] protected session plaintext frame {t!r}",
            file=sys.stderr,
        )
        return None

    def _set_out_pending(self, frames: deque[str] | list[str]) -> None:
        """#380 整表替換 pending 時重算字節計數。"""
        self._out_pending = deque(frames)
        self._out_pending_bytes = sum(len(f.encode("utf-8")) for f in self._out_pending)

    def _enqueue_out_pending(self, data: str) -> None:
        """#380 出站緩衝：幀數 + 總字節雙限，超限丟最舊。"""
        # 測試/旁路若直接賦值 _out_pending，字節計數可能失步——入隊前重算。
        self._out_pending_bytes = sum(len(f.encode("utf-8")) for f in self._out_pending)
        nbytes = len(data.encode("utf-8"))
        if nbytes > LINKB_MAX_FRAME_BYTES:
            print(
                f"[Link B outbound dropped] {nbytes} bytes > max frame",
                file=sys.stderr,
            )
            return
        dropped = 0
        while self._out_pending and (
            len(self._out_pending) >= LINKB_PENDING_MAX
            or self._out_pending_bytes + nbytes > LINKB_PENDING_MAX_BYTES
        ):
            old = self._out_pending.popleft()
            self._out_pending_bytes -= len(old.encode("utf-8"))
            dropped += 1
        if self._out_pending_bytes + nbytes > LINKB_PENDING_MAX_BYTES:
            print(
                f"[Link B pending drop] frame {nbytes} bytes exceeds remaining byte budget",
                file=sys.stderr,
            )
            return
        if dropped:
            print(
                f"⚠️ Link B pending backpressure: dropped {dropped} oldest frame(s)",
                file=sys.stderr,
            )
        self._out_pending.append(data)
        self._out_pending_bytes += nbytes

    def _drop_queued_for_protected(self, protected: set[str]) -> None:
        """ready floor 提升时丢弃此前按 plaintext 状态积压的整帧/批内 session。"""
        if not protected or not self._out_pending:
            return
        kept: list[str] = []
        dropped_frames = 0
        dropped_sessions = 0
        for raw in self._out_pending:
            try:
                msg = json.loads(raw)
            except Exception:
                dropped_frames += 1
                continue
            if not isinstance(msg, dict):
                dropped_frames += 1
                continue
            if msg.get("t") in ("import_batch", "mirror_append") and isinstance(
                msg.get("sessions"), list
            ):
                sessions = [
                    session
                    for session in msg["sessions"]
                    if not (
                        isinstance(session, dict)
                        and session.get("hermesSessionId") in protected
                    )
                ]
                dropped_sessions += len(msg["sessions"]) - len(sessions)
                if not sessions and not (
                    msg.get("t") == "import_batch" and msg.get("done") is True
                ):
                    dropped_frames += 1
                    continue
                msg = {**msg, "sessions": sessions}
            if self._outbound_session_ids(msg).intersection(protected):
                dropped_frames += 1
                continue
            kept.append(json.dumps(msg, ensure_ascii=False))
        self._set_out_pending(kept)
        if dropped_frames or dropped_sessions:
            print(
                "⚠️ E2E ready 对账清除首连前明文："
                f"{dropped_frames} 帧、{dropped_sessions} 个批次 session",
                file=sys.stderr,
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
        # #669 gateway 死了，它掛起的審批也跟着死——別讓心跳的 pendingApproval 永久黏住 true。
        self._plain_approvals.clear()
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
            if self._e2e.is_protected(server_sid):
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

    async def _rewind_hermes(self, server_sid: str, target_src_id: str) -> tuple[bool, int, str | None]:
        """#473 把 state.db 會話回退到 target_src_id 這條用戶消息之前。

        Hermes 原生就有這個能力（`/undo` 走同一個 SessionDB API）：軟刪 id ≥ target 的行
        （`active=0`，留檔可審計），要求 target 是 user 行。我們的 srcId 恰好就是 state.db
        行 id，故不需要任何映射。

        回 (ok, rewound_count, error_code)。
        """
        real = self._stored.get(server_sid) or self._fwd.get(server_sid, server_sid)
        try:
            target_id = int(str(target_src_id).strip())
        except (TypeError, ValueError):
            return False, 0, "not_found"  # 非 state.db 行 id（導入/舊會話）→ 定位不到

        def _do():
            db = self._session_db()
            sid = db.resolve_session_id(real) or real
            return sid, db.rewind_to_message(sid, target_id)

        try:
            sid, res = await asyncio.to_thread(_do)
        except ValueError:
            # rewind_to_message 對「行不存在 / 不屬該會話 / 非 user 角色」拋 ValueError。
            return False, 0, "not_found"
        except Exception as exc:
            print(f"[rewind failed] {exc!r}", file=sys.stderr)
            return False, 0, "failed"
        rewound = int(res.get("rewound_count") or 0)
        # 運行時句柄必須丟掉:gateway 進程裡那份 conversation_history 是**記憶體態**,
        # 底下的行軟刪了它也不知道。清映射 → 下個 prompt 走 session.resume 重讀 state.db,
        # 拿到的才是截斷後的上下文。
        real_ids = {real, sid}
        self._fwd.pop(server_sid, None)
        for rid in list(self._rev):
            if rid in real_ids or self._rev.get(rid) == server_sid:
                self._rev.pop(rid, None)
        print(f"· session.rewind {sid} → 軟刪 {rewound} 行(active=0),運行時句柄已丟")
        return True, rewound, None

    async def _set_hermes_title(self, server_sid: str, title: str) -> None:
        # #161 手動改名回寫(archive 同款路徑):自驅會話用持久映射的 state.db id;導入會話用原值。
        real = self._stored.get(server_sid) or self._fwd.get(server_sid, server_sid)

        def _do():
            db = self._session_db()
            sid = db.resolve_session_id(real) or real
            return sid, db.set_session_title(sid, title)

        sid, ok = await asyncio.to_thread(_do)
        # #381:标题正文不进默认日志
        print(f"· session.rename {short_id(sid)} len={text_len(title)} ({'ok' if ok else 'no-op'})")
        log_content("session.rename", title)

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

    async def _attach_to_session(self, real_sid: str, ref: dict) -> str:
        # 入站附件：下載 presigned url → image.attach/file.attach；回傳落盤路徑給調用方拼進 prompt。
        # #855:file.attach 只把文件當可讀工件、不注入本回合輸入——必須把路徑寫進正文,
        # 否則 agent 只看到光禿文字,得自己 grep 文件名才找得到(用戶實測 PDF 正是這樣)。
        #
        # #917 落盤與登記分開對待:**文件已經在盤上**這件事一旦成立,這條消息就算送到了——
        # gateway 的 attach 只是把它掛進 artifacts 列表,掛不上不影響 agent 按正文裡的路徑讀它。
        # 此前 attach 一拋就整條算失敗、路徑註記也一起丟,等於因為「沒登記」而把已到手的文件藏起來。
        path = await asyncio.to_thread(_materialize_attachment, ref)
        method = "image.attach" if ref.get("kind") == "image" else "file.attach"
        try:
            await self.gw.request(method, {"session_id": real_sid, "path": path})
        except Exception as exc:
            print(f"[attach 登記失敗(文件已落盤,照常給 agent 路徑)] {exc!r}", file=sys.stderr)
            return path
        # #381:附件名/URL 不落默认日志
        print(f"· 附件 {method} nameLen={text_len(ref.get('name'))} → {short_id(real_sid)}")
        log_content("attach", str(ref.get("name") or ""))
        return path

    @staticmethod
    def _attach_note(ref: dict, path: str) -> str:
        """#855 入站附件路徑註記——對齊 CC/Codex:agent 本回合輸入裡就有「這條消息帶了這個文件」。
        #859 視頻額外提示 ffmpeg 抽幀（多數模型無原生視頻輸入）。"""
        name = (str(ref.get("name") or "").strip() or "file")[:120]
        mime = (str(ref.get("mime") or "").strip() or "?")[:80]
        kind = str(ref.get("kind") or "")
        base = f"[Macchiato 附件 {name}({mime})已保存到:{path}]"
        if kind == "video" or mime.startswith("video/"):
            return (
                f"{base}\n"
                f"[這是一段視頻。模型通常不能直接讀視頻，可用 ffmpeg 抽幀後查看，"
                f"例如: ffmpeg -i {path} -vf fps=1/5 frame_%03d.jpg]"
            )
        return base

    @staticmethod
    def _merge_attach_notes(text: str, notes: list[str]) -> str:
        if not notes:
            return text
        block = "\n".join(notes)
        return f"{text}\n\n{block}" if text else block

    async def _attach_refs(
        self, server_sid: str, real_sid: str, refs: list
    ) -> tuple[list[str], list[str]]:
        """落盤 + gateway attach。回 (notes, failed_labels)；失敗只記名、不拋——
        調用方把 notes 拼進 prompt,failed 走 review.summary 讓用戶看見(#855)。"""
        notes: list[str] = []
        failed: list[str] = []
        reasons: list[str] = []
        for ref in refs or []:
            label = (str(ref.get("name") or "").strip() or str(ref.get("id") or "file"))[:80]
            try:
                path = await self._attach_to_session(real_sid, ref)
                notes.append(self._attach_note(ref, path))
            except Exception as exc:
                print(f"[attach failed {label!r}] {exc!r}", file=sys.stderr)
                failed.append(label)
                reasons.append(_scrub_reason(exc))
        if failed:
            # 與 Codex 同形:用戶側氣泡掛着附件,agent 側卻沒收到時不能只 silently print。
            # #917 帶上原因:光一句「下載失敗」既幫不到用戶(不知道下一步做什麼),
            # 也幫不到我們(#917 查到根因全靠用戶另開一輪會話讓 agent 滿盤搜文件)。
            names = "、".join(failed)
            why = reasons[0] if len(set(reasons)) == 1 else "；".join(reasons)
            await self._to_server(
                server_sid,
                {
                    "jsonrpc": "2.0",
                    "method": "event",
                    "params": {
                        "type": "review.summary",
                        "session_id": server_sid,
                        "payload": {
                            "summary": f"⚠️ 附件下載失敗:{names}（{why}）" if why else f"⚠️ 附件下載失敗:{names}",
                        },
                    },
                },
            )
        return notes, failed

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
            print(
                f"· session.title len={text_len(title)} → {short_id(server_sid)}",
                file=sys.stderr,
            )
            log_content("session.title", title)
        except Exception as exc:
            print(f"[auto_title failed for {short_id(server_sid)}] {safe_err(exc)}", file=sys.stderr)

    @staticmethod
    def _has_title(state_sid: str) -> bool:
        """state.db 該會話是否已有非空標題（重啟後避免重生;渠道會話 Hermes 已起名）。"""
        import sqlite3

        db = os.path.join(_hermes_home(), "state.db")  # #309 尊重 HERMES_HOME(profile 實例)
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

    async def _deny_e2e_approval(self, real_sid: str) -> None:
        try:
            if self.gw is not None:
                await self.gw.request(
                    "approval.respond",
                    {"session_id": real_sid, "choice": "no", "all": False},
                )
        except Exception as exc:
            print(f"[E2E approval auto-deny failed {real_sid}] {exc!r}", file=sys.stderr)

    async def _deny_e2e_interactive(self, real_sid: str, etype: str, payload: dict) -> None:
        """#273:clarify/secret 無法加密放行時本地 skip 解掛,避免 agent 永久掛起。"""
        request_id = str(payload.get("request_id") or "")
        if not request_id or self.gw is None:
            return
        try:
            if etype == "clarify.request":
                await self.gw.request(
                    "clarify.respond",
                    {"request_id": request_id, "answer": ""},
                )
            elif etype == "secret.request":
                await self.gw.request(
                    "secret.respond",
                    {"request_id": request_id, "value": ""},
                )
        except Exception as exc:
            print(f"[E2E {etype} auto-skip failed {real_sid}] {exc!r}", file=sys.stderr)

    def _e2e_track_interactive(
        self,
        server_sid: str,
        kind: str,
        request_id: str,
        digest: str,
        execution_request: dict,
    ) -> None:
        self._e2e_interactives[request_id] = {
            "kind": kind,
            "serverSid": server_sid,
            "requestId": request_id,
            "requestDigest": digest,
            "executionRequest": execution_request,
        }
        self._e2e_interactives.move_to_end(request_id)
        # 越界丟最老的：那些早就沒人會答了（gateway 側的 pending 早已隨回合結束消失）。
        while len(self._e2e_interactives) > E2E_INTERACTIVE_PENDING_MAX:
            dropped, _ = self._e2e_interactives.popitem(last=False)
            print(
                f"[E2E interactive pending overflow] dropped {dropped}",
                file=sys.stderr,
            )

    def _e2e_live_frame(self, server_sid: str, etype: str, payload: dict) -> dict | None:
        """§19 E2E 會話的 live 事件過濾(#240/#273)。返回要轉發的 event frame,或 None(抑制)。
        - approval.request:命令/說明加密進 enc,明文只留占位 + pattern_key/request_id(元數據);
          #370 request_id + request_digest 同时放进密文，设备签封回带；server 不能换卡/伪造 always。
        - clarify.request / secret.request(#273):問題/選項/prompt 進 enc；回程 answerEnc/secretEnc。
        - 其餘(message.*/tool.* 走加密鏡像):抑制。"""
        # #273 能力協商：沒有設備自報解得開，就返回 None → 調用方走 _deny_e2e_interactive
        # （本地 skip 解掛，即 #273 之前的行為）。**絕不降級成明文** clarify——那會把問題/選項
        # 旁路送往 server，是比「回合掛起」嚴重得多的洩漏。能力位不用人記得發版順序。
        if etype == "clarify.request":
            if not self._e2e.device_supports(server_sid, "clarify"):
                print(
                    f"[E2E clarify] {server_sid}: 無設備自報可解密 → 本地跳過(#273 之前的行為);"
                    "帶客戶端側的 app 上架並註冊後自動啟用",
                    file=sys.stderr,
                )
                return None
            return self._e2e_live_clarify(server_sid, payload)
        if etype == "secret.request":
            if not self._e2e.device_supports(server_sid, "secret"):
                print(
                    f"[E2E secret] {server_sid}: 無設備自報可解密 → 本地跳過(#273 之前的行為)",
                    file=sys.stderr,
                )
                return None
            return self._e2e_live_secret(server_sid, payload)
        if etype != "approval.request":
            return None
        request_id = str(payload.get("request_id") or f"hermes-{uuid.uuid4()}")
        pattern_key = str(payload.get("pattern_key") or "")
        if not pattern_key:
            print(
                f"[E2E approval rejected {server_sid}] missing authenticated pattern key",
                file=sys.stderr,
            )
            return None
        try:
            # JSON round-trip freezes the exact local gateway request. Neither later mutation of
            # `payload` nor server-side display fields may alter what this approval authorizes.
            request_snapshot = json.loads(visible_stable_json(payload))
            execution_request = {
                "v": 1,
                "connector": "hermes",
                "sessionId": server_sid,
                "requestId": request_id,
                "method": "approval.respond",
                "request": request_snapshot,
            }
            execution_display = visible_stable_json(execution_request)
            if len(execution_display.encode("utf-8")) > 48 * 1024:
                raise ValueError("canonical approval display exceeds 48 KiB")
        except Exception as exc:
            print(
                f"[E2E approval rejected {server_sid}] cannot freeze full request: {exc!r}",
                file=sys.stderr,
            )
            return None
        digest = request_digest(
            self._e2e.require_key(server_sid),
            execution_request,
        )
        approval_payload = {
            "command": request_snapshot.get("command", ""),
            "description": request_snapshot.get("description", ""),
            # UI 的本地化/详情选择会受 patternKey 影响；必须和 command 一样来自 K_S
            # 密文，不能继续信任 server 可改写的 outer pattern_key。
            "patternKey": pattern_key,
            "requestId": request_id,
            "requestDigest": digest,
            "executionRequest": execution_request,
            "executionDisplay": execution_display,
        }
        approval_plaintext = visible_stable_json(approval_payload)
        if len(approval_plaintext.encode("utf-8")) > E2E_APPROVAL_PLAINTEXT_MAX:
            print(
                f"[E2E approval rejected {server_sid}] encrypted plaintext exceeds 64 KiB",
                file=sys.stderr,
            )
            return None
        enc = self._e2e.encrypt_serialized_content(server_sid, approval_plaintext)
        out = {
            "command": "🔒 加密審批請求",
            "pattern_key": payload.get("pattern_key", ""),
            "pattern_keys": payload.get("pattern_keys", []),
            "description": "",
            "request_id": request_id,
            "request_digest": digest,
            "enc": enc,
        }
        if not hasattr(self, "_e2e_approvals"):
            self._e2e_approvals = {}
        pending = self._e2e_approvals.setdefault(server_sid, deque())
        pending.append(
            {
                "requestId": request_id,
                "requestDigest": digest,
                "executionRequest": execution_request,
            }
        )
        return {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {"type": "approval.request", "session_id": server_sid, "payload": out},
        }

    def _e2e_live_clarify(self, server_sid: str, payload: dict) -> dict | None:
        """#273 E2E clarify.request → enc 放行。"""
        request_id = str(payload.get("request_id") or "").strip()
        if not request_id:
            print(f"[E2E clarify rejected {server_sid}] missing request_id", file=sys.stderr)
            return None
        try:
            request_snapshot = json.loads(visible_stable_json(payload))
            execution_request = {
                "v": 1,
                "connector": "hermes",
                "sessionId": server_sid,
                "requestId": request_id,
                "method": "clarify.respond",
                "request": request_snapshot,
            }
            execution_display = visible_stable_json(execution_request)
            if len(execution_display.encode("utf-8")) > 48 * 1024:
                raise ValueError("canonical clarify display exceeds 48 KiB")
        except Exception as exc:
            print(
                f"[E2E clarify rejected {server_sid}] cannot freeze request: {exc!r}",
                file=sys.stderr,
            )
            return None
        # ⚠️ require_key / encrypt 也必須包在 try 裡:on_event 只在本函數**返回 None** 時才走
        # `_deny_e2e_interactive` 兜底解掛;讓異常穿出去 = gateway 那條 clarify 永遠等下去。
        try:
            digest = request_digest(self._e2e.require_key(server_sid), execution_request)
            question = str(request_snapshot.get("question") or "")
            choices = request_snapshot.get("choices")
            multi = False
            if isinstance(choices, dict) and choices.get("multiSelect") is True:
                multi = True
            plaintext_obj = {
                "question": question,
                "choices": choices if choices is not None else {},
                "multiSelect": multi,
                "requestId": request_id,
                "requestDigest": digest,
                "executionRequest": execution_request,
                "executionDisplay": execution_display,
            }
            plaintext = visible_stable_json(plaintext_obj)
            if len(plaintext.encode("utf-8")) > E2E_APPROVAL_PLAINTEXT_MAX:
                raise ValueError("encrypted plaintext exceeds 64 KiB")
            enc = self._e2e.encrypt_serialized_content(server_sid, plaintext)
        except Exception as exc:
            print(
                f"[E2E clarify rejected {server_sid}] cannot encrypt: {exc!r}",
                file=sys.stderr,
            )
            return None
        self._e2e_track_interactive(server_sid, "clarify", request_id, digest, execution_request)
        return {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {
                "type": "clarify.request",
                "session_id": server_sid,
                "payload": {
                    "question": "🔒 Encrypted question",
                    "choices": {},
                    "request_id": request_id,
                    "request_digest": digest,
                    "enc": enc,
                },
            },
        }

    def _e2e_live_secret(self, server_sid: str, payload: dict) -> dict | None:
        """#273 E2E secret.request → enc 放行。"""
        request_id = str(payload.get("request_id") or "").strip()
        if not request_id:
            print(f"[E2E secret rejected {server_sid}] missing request_id", file=sys.stderr)
            return None
        try:
            request_snapshot = json.loads(visible_stable_json(payload))
            execution_request = {
                "v": 1,
                "connector": "hermes",
                "sessionId": server_sid,
                "requestId": request_id,
                "method": "secret.respond",
                "request": request_snapshot,
            }
            execution_display = visible_stable_json(execution_request)
            if len(execution_display.encode("utf-8")) > 48 * 1024:
                raise ValueError("canonical secret display exceeds 48 KiB")
        except Exception as exc:
            print(
                f"[E2E secret rejected {server_sid}] cannot freeze request: {exc!r}",
                file=sys.stderr,
            )
            return None
        # 同 clarify:異常必須收斂成 None,否則 on_event 的 skip 兜底跑不到,gateway 永久掛起。
        try:
            digest = request_digest(self._e2e.require_key(server_sid), execution_request)
            prompt = str(request_snapshot.get("prompt") or "")
            env_var = str(request_snapshot.get("env_var") or "")
            plaintext_obj = {
                "prompt": prompt,
                "envVar": env_var,
                "requestId": request_id,
                "requestDigest": digest,
                "executionRequest": execution_request,
                "executionDisplay": execution_display,
            }
            plaintext = visible_stable_json(plaintext_obj)
            if len(plaintext.encode("utf-8")) > E2E_APPROVAL_PLAINTEXT_MAX:
                raise ValueError("encrypted plaintext exceeds 64 KiB")
            enc = self._e2e.encrypt_serialized_content(server_sid, plaintext)
        except Exception as exc:
            print(
                f"[E2E secret rejected {server_sid}] cannot encrypt: {exc!r}",
                file=sys.stderr,
            )
            return None
        self._e2e_track_interactive(server_sid, "secret", request_id, digest, execution_request)
        return {
            "jsonrpc": "2.0",
            "method": "event",
            "params": {
                "type": "secret.request",
                "session_id": server_sid,
                "payload": {
                    "prompt": "🔒 Encrypted secret request",
                    "env_var": "",
                    "request_id": request_id,
                    "request_digest": digest,
                    "enc": enc,
                },
            },
        }

    async def _emit_media_from_text(self, server_sid: str, text: str) -> None:
        # #158/#372 出站附件:僅 MEDIA: + 允許根內(session cwd / ATTACH_DIR / STATE_DIR /
        # MACCHIATO_MEDIA_ALLOW_ROOTS);裸路徑與根外(/etc、~/.ssh…)一律不讀不傳。
        roots = _media_allow_roots(
            session_cwd=self._cwds.get(server_sid),
            state_dir=STATE_DIR,
            attach_dir=ATTACH_DIR,
        )
        try:
            paths = await asyncio.to_thread(_extract_media_files, text, roots)
        except Exception as exc:
            print(f"[extract_media failed] {exc!r}", file=sys.stderr)
            return
        for path in paths:
            try:
                payload = await asyncio.to_thread(_read_media_file, path, roots)
            except Exception as exc:
                # #381/#372:不落完整路徑(可能敏感);只記 path_len + 錯型
                print(
                    f"[read media failed] path_len={len(path)} err={type(exc).__name__}",
                    file=sys.stderr,
                )
                continue
            if payload is None:
                continue
            frame = {
                "jsonrpc": "2.0",
                "method": "event",
                "params": {"type": "media.attach", "session_id": server_sid, "payload": payload},
            }
            await self._to_server(server_sid, frame)
            # #381:文件名可能含客户路径,默认只记 size
            print(f"· media.attach size={payload['size']}B → {short_id(server_sid)}")
            log_content("media.attach", str(payload.get("name") or ""))

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

    # #656 driven 標記的 TTL。它只需要橋住「prompt 到達 → `_ensure_session` 寫完 `_fwd`」這一小段
    # (一次 gateway 往返 + 串行鏈排隊),之後 `_fwd` 永久接手。給 5 分鐘純粹是兜底:萬一那一輪
    # 徹底失敗(gateway 死/會話建不起來),標記也必須自己過期——鏡像被永久擋住比重複更糟(消息不見了)。
    DRIVING_TTL_S = 300.0

    def _mark_driving(self, server_sid: str) -> None:
        """收到 prompt.submit 即標記。**必須同步調用**(讀循環裡,任何 await 之前)——這個標記存在的
        全部理由就是覆蓋那些 await 期間的窗口。"""
        self._driving[server_sid] = time.monotonic() + self.DRIVING_TTL_S

    def _clear_driving(self, server_sid: str) -> None:
        self._driving.pop(server_sid, None)

    def _is_driving(self, sid: str) -> bool:
        """鏡像用:這個 state.db 會話此刻是不是本端在驅動(過期即不算)。"""
        until = self._driving.get(sid)
        if until is None:
            return False
        if time.monotonic() >= until:
            self._driving.pop(sid, None)
            return False
        return True

    def _db_sid(self, server_sid: str):
        """#601 這個會話在 state.db 裡的 id（srcId 回填要拿它讀 turn_rows）。

        自驅會話走持久映射 `_stored`（重啟後仍在）；鏡像來源的會話 server_sid 本身就是
        state.db id，由 `_ensure_session` 記進運行時 `_dbsid`（重啟後首個 prompt 會重記）。
        兩張表都沒有 = 這個會話還沒解析過，本回合不回填（照舊靜默跳過）。
        """
        return self._stored.get(server_sid) or self._dbsid.get(server_sid)

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

    def _protected_inbound_alias_owner(self, identity: str) -> str | None:
        """把 state.db/runtime 本地 id 反查到 canonical protected wire sid。

        `_ensure_session(identity)` 会优先直接 resume identity；若不做反查，server 可把受保护
        会话的本地 id 当成一条未保护会话，绕过 prompt 解密与控制认证。
        """
        protected = self._e2e.protected_session_ids()
        for wire_sid in protected:
            if wire_sid == identity:
                continue
            if _same_local_uuid(wire_sid, identity):
                return wire_sid
            stored = self._stored.get(wire_sid)
            runtime = self._fwd.get(wire_sid)
            if (
                stored == identity
                or runtime == identity
                or isinstance(stored, str)
                and _same_local_uuid(stored, identity)
                or isinstance(runtime, str)
                and _same_local_uuid(runtime, identity)
            ):
                return wire_sid
        reverse_identities = {identity}
        if _UUID_ID_RE.fullmatch(identity):
            lower_identity = identity.lower()
            reverse_identities.update(
                key
                for key in (*self._stored_rev.keys(), *self._rev.keys())
                if isinstance(key, str)
                and _UUID_ID_RE.fullmatch(key)
                and key.lower() == lower_identity
            )
        for reverse_identity in reverse_identities:
            owners = (
                self._stored_rev.get(reverse_identity),
                self._rev.get(reverse_identity),
            )
            for owner in owners:
                if owner and owner != identity and owner in protected:
                    return owner
        return None

    async def _emit_cwd_reject(self, server_sid: str, reason: str) -> None:
        """#423 顯式 cwd 校驗失敗 → 與 TS 兩家同形的 review.summary 提示(fail closed)。"""
        err = f"⚠️ {reason}(連接器主機上)。請修正會話目錄後重發。"
        print(f"[#423 cwd 拒絕 {server_sid}] {reason}", file=sys.stderr)
        await self._to_server(
            server_sid,
            {
                "jsonrpc": "2.0",
                "method": "event",
                "params": {
                    "type": "review.summary",
                    "session_id": server_sid,
                    "payload": {"summary": err},
                },
            },
        )

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
                # #601 續聊路徑也要記住 state.db id——此前只有 create 分支記（`_record_stored`），
                # 於是「鏡像來源的會話在 app 裡續聊」永遠拿不到 floor、srcId 回填整條靜默跳過
                # （`_backfill_srcids` 首行 `not stored` 就 return），live 行的 dedup_key 恆為空，
                # 鏡像隨後把同一行再投一遍 = 用戶消息在對話裡出現兩次。
                self._dbsid[server_sid] = (res or {}).get("stored_session_id") or target
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
            # #227/#423 per-session cwd:只把校驗過的路徑交給 gateway(防 _cwds 殘留壞值透傳)
            cwd_raw = self._cwds.get(server_sid)
            cwd = None
            if cwd_raw:
                cres = resolve_cwd(cwd_raw)
                if cres.ok and cres.cwd:
                    cwd = cres.cwd
                    if cwd != cwd_raw:
                        self._cwds[server_sid] = cwd  # 規範化 realpath
                else:
                    # 存過但現在壞了(目錄被刪/allowlist 收緊)→ 不透傳;清掉以免反覆踩
                    self._cwds.pop(server_sid, None)
                    print(
                        f"[#423] create 前 cwd 失效,改不帶 cwd 建會話:{getattr(cres, 'reason', cwd_raw)}",
                        file=sys.stderr,
                    )
            res = await self.gw.create_session(**({"cwd": cwd} if cwd else {}))
            real = res.get("session_id")
            stored = (res or {}).get("stored_session_id")
            self._record_stored(server_sid, stored)
            if stored:
                self._dbsid[server_sid] = stored  # #601 同上，回填用
            print(f"· created hermes session {real} ← server {server_sid}（state.db={stored}）")
        self._fwd[server_sid] = real
        self._rev[real] = server_sid
        # #656 `_fwd/_rev` 接手之後,driven 標記就沒用了(它只負責橋住到這裡為止的那段窗口)。
        # 不撤也只是 5 分鐘後過期,但撤掉語義更乾淨:任一時刻只有一個東西在說「這會話歸 live」。
        self._clear_driving(server_sid)
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
            # #855:重投路徑也拼路徑註記。若首次已把註記寫進 text,再 append 會重複——
            # 用「路徑是否已在正文」去重;GatewayDied 在 attach 之前時 text 尚無註記,必須在此補上。
            notes, _failed = await self._attach_refs(server_sid, real, attachments or [])
            extra = [n for n in notes if n not in (text or "")]
            submit_text = self._merge_attach_notes(text or "", extra)
            try:
                await self.gw.submit_prompt(real, submit_text)
            except GatewayError as exc:
                if exc.code == 4009 and submit_text:
                    await self.gw.steer(real, submit_text)
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
        stored = self._db_sid(server_sid)  # #601 自驅走持久映射,鏡像來源的會話 server_sid 即 state.db id
        try:
            if floor is None or not stored:
                return
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
            max_row = max(r[0] for r in rows)
            self._turn_floor[server_sid] = max_row  # 下回合 floor 順勢推進
            await self._send({
                "t": "message_srcid",
                "agentLinkId": self.agent_link_id,
                "sessionId": server_sid,
                "items": items,
            })
            self._count("srcidBackfills")  # #10
            # #614 回填即推鏡像水位:到這裡,≤max_row 的行「已 live 投遞 + 已回填 dedup_key」,
            # 鏡像永遠不需要再投它們。此前這只靠運行時 _rev/_fwd 跳過——連接器一重啟就失憶,
            # 鏡像從凍結的舊水位把整段歷史重放(2026-07-22 12:15Z 實錘:28 對重複 = 重啟分鐘級吻合)。
            # E2E 不推(其內容只有加密鏡像一條路,原守衛不變;E2E live 被抑制,常態也到不了這裡)。
            if (
                self._mirror_st is not None
                and not self._e2e.is_protected(server_sid)
                and not self._e2e.is_protected(stored)
            ):
                wm = self._mirror_st["sessions"]
                if max_row > wm.get(stored, 0):
                    wm[stored] = max_row
                    self._save_mirror_state(self._mirror_st)
        except Exception as exc:
            print(f"[#13 srcid 回填失敗(忽略) {server_sid}] {exc!r}", file=sys.stderr)
        finally:
            # #601 無論成敗、包括上面那條提前 return,都要放行:回填有 10s 上限,
            # 不能讓一次失敗/跳過把該會話的鏡像永久卡住。
            if stored:
                self._srcid_pending.discard(stored)

    async def _send(self, msg: dict) -> bool:
        """斷線期間**緩衝**、ready 後按序補發(此前直接丟——server 部署重啟撞上進行中回合,
        回覆/標題被靜默丟掉,會話卡成「影子」,2026-07-12 實測)。鏡像/健康/pong 有自愈或時效性,照舊丟。
        返回「是否已實際發出」(緩衝/丟棄 → False)——鏡像靠它決定推不推水位線(#239):
        失敗批若照推,server 沒收到就永不 nack,消息永久丟失且無自愈路徑。"""
        msg = self._sanitize_protected_outbound(msg)
        if msg is None:
            return False
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
        self._enqueue_out_pending(data)
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
            # #380 limit=換行前硬字節上限（StreamReader 默認僅 64KiB，放寬到 1MiB 並硬頂）。
            self._push_server = await asyncio.start_unix_server(
                self._push_handler,
                path=PUSH_SOCK,
                limit=PUSH_MAX_LINE_BYTES,
            )
            os.chmod(PUSH_SOCK, 0o600)  # 僅本用戶可投遞（本機 IPC）
            print(f"· 主動投遞 socket 已啟（{PUSH_SOCK}）")
        except Exception as exc:
            print(f"[push socket 啟動失敗] {exc!r}", file=sys.stderr)

    def _push_media_payloads(self, raw_files) -> list:
        """#280 主動投遞附件:plugin 給本地路徑 → 允許根校驗 + 讀盤 → media.attach 同 shape。

        安全(對齊 live MEDIA: 路徑 #372):
          - 僅本地常規文件、realpath 後落在允許根內(STATE/ATTACH/hermes **媒體子目錄**/env 擴展根)
          - 大小上限 MEDIA_MAX;symlink 逃逸拒;路徑正文不進日誌
          - 單次最多 PUSH_MEDIA_MAX_FILES 個(防炸 Link B 幀)
        任一失敗 silently skip 該檔(文字仍投),不整包拒絕。

        ⚠️ **不把整個 HERMES_HOME 當允許根**:那裡有 `.env`(API key)、`state.db`(全部歷史對話)。
        路徑來自 agent 調 `send_message_tool(media_files=…)`,即模型輸出可控——而
        「模型輸出不是可信授權邊界」正是 #372 的前提。整個 home 開放 = prompt injection
        可以把憑證/對話庫當「圖表」投遞出去(server 的 mime 白名單只是最後一道,
        改個 .pdf 後綴就能繞)。只認 cron 產物該去的媒體子目錄;真需要別處用
        MACCHIATO_MEDIA_ALLOW_ROOTS 顯式開,那是用戶的顯式授權,不是模型的。
        """
        if not raw_files or not isinstance(raw_files, (list, tuple)):
            return []
        # cron 無 session cwd;允許 hermes home **下的媒體子目錄**(cron 產物的常見落點)。
        hermes_home = ""
        try:
            from hermes_constants import get_hermes_home

            hermes_home = str(get_hermes_home())
        except Exception:
            hermes_home = (os.environ.get("HERMES_HOME") or "").strip() or os.path.expanduser(
                "~/.hermes"
            )
        extra: list[str] = [
            os.path.join(hermes_home, sub) for sub in ("media", "outbox", "attachments", "tmp")
        ]
        roots = _media_allow_roots(
            state_dir=STATE_DIR,
            attach_dir=ATTACH_DIR,
            extra_roots=extra,
        )
        out: list = []
        seen: set[str] = set()
        for raw in raw_files:
            if len(out) >= PUSH_MEDIA_MAX_FILES:
                print(
                    f"[push media] cap={PUSH_MEDIA_MAX_FILES} remaining skipped",
                    file=sys.stderr,
                )
                break
            path = str(raw or "").strip()
            if not path or path in seen:
                continue
            seen.add(path)
            try:
                payload = _read_media_file(path, roots)
            except Exception as exc:
                print(
                    f"[push media read failed] path_len={len(path)} err={type(exc).__name__}",
                    file=sys.stderr,
                )
                continue
            if payload is None:
                continue
            out.append(payload)
        return out

    async def _push_handler(self, reader, writer) -> None:
        """單條請求：讀一行 JSON {chatId,text,mediaFiles?,...} → 經 Link B 發 connector_push → 回 ack 行。"""
        ack: dict = {"ok": False, "error": "unknown"}
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            if len(line) > PUSH_MAX_LINE_BYTES:
                ack = {"ok": False, "error": "line too large"}
            else:
                req = json.loads(line.decode("utf-8")) if line else {}
                chat_id = str(req.get("chatId") or "")
                # #160 deliver-to-origin:chatId 若是本地 state.db 會話 id → 翻譯成 server sid
                # (server 按 hermesSessionId 歸位原會話;翻不出原樣傳,home/自定義名照舊落收件箱)。
                chat_id = self._stored_rev.get(chat_id, chat_id)
                text = req.get("text") or ""
                if not chat_id or not text:
                    ack = {"ok": False, "error": "missing chatId/text"}
                elif self._e2e.is_protected(chat_id) or self._e2e.is_protected(f"macchiato:{chat_id}"):
                    # connector_push 的 wire shape 只有明文 text(+可選 media base64)。目的會話
                    # （含 server 的 inbox fallback sid）受 E2E 保護時必須在本機拒絕，
                    # 不能先把正文/附件交給 server。
                    ack = {"ok": False, "error": "E2E push unsupported"}
                elif self.ws is None:
                    ack = {"ok": False, "error": "link B down", "retryable": True}
                else:
                    # #280 讀本地路徑 → base64 media[](可選);失敗檔跳過,文字照投。
                    media_raw = req.get("mediaFiles") or req.get("media_files") or []
                    media = await asyncio.to_thread(self._push_media_payloads, media_raw)
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
                    if media:
                        msg["media"] = media
                    await self._send(msg)
                    media_note = f", media={len(media)}" if media else ""
                    print(
                        f"· 主動投遞 → server（chat={chat_id[:24]}, push {pid}, "
                        f"{len(text)} 字{media_note}）"
                    )
                    ack = {"ok": True, "messageId": f"push:{pid}", "mediaCount": len(media)}
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
                st.setdefault("pendingE2EBackfills", {})
                # F-01 / #348：日常 mirror_append 的 durable outbox（幀落盤 → ACK 才推水位）。
                if not isinstance(st.get("pendingMirrors"), list):
                    st["pendingMirrors"] = []
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
        return {
            "baseline": None,
            "sessions": {},
            "pendingE2EBackfills": {},
            "pendingMirrors": [],
        }

    def _save_mirror_state(self, st: dict, *, strict: bool = False) -> None:
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
            if strict:
                raise

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
            # #773 尾部再兜一句「新版已裝好、等重啟」——降級原因與鏡像錯誤都排在它前面,
            # 信息位絕不蓋掉真問題(#348 靜默凍結的教訓)。它也不參與 degraded 判定
            # (server registry.ts 的 healthFromState 只看 gatewayAlive/compatOk/
            # mirrorStuck/authOk),所以不會誤亮黃燈。
            "lastError": (
                self._degrade_reason()
                or self._last_error
                or getattr(self, "_self_update_notice", None)
            ),
            "connectorVersion": CONNECTOR_VERSION,  # §update：server 據此判 updateAvailable
            # #768 磁盤版（裝完未重啟時 > 進程版）
            "installedVersion": _report_installed_version(CONNECTOR_VERSION),
            "kind": "hermes",  # #94：client gate 專屬功能（如 AI 重命名）
            "stt": _stt_available(),  # #89：語音轉錄能力位（false → server 走雲端 BYOK STT）
            "counters": dict(getattr(self, "_counters", {}) or {}),  # #10：累計計數（進程生命週期）
        }

    def _self_update(self) -> None:
        """§update：收到 server 的 self_update → **驗證鏈全過才執行**（#1 供應鏈加固）：
        release.json+.sig 內嵌公鑰驗簽 → bootstrap bridge + 嚴格升版 → install.sh sha256
        對上清單 → 從本地臨時文件跑（非 curl|bash 管道），清單經 MACCHIATO_MANIFEST 傳入
        供逐文件校驗。
        systemd 重啟會殺掉本進程並起新版；非 systemd（手動跑）則只更新文件、下次重啟生效。
        #773：後一種情況下這個閂不再永久鎖死——見 _on_installer_exit。"""
        if getattr(self, "_self_update_started", False):
            # #791:不覆蓋已有 pending-restart / failure 文案——用戶該看到「為什麼沒換代」。
            print("[self_update ignored] 已在本进程启动，拒绝并发/重放安装", file=sys.stderr)
            return
        self._self_update_started = True
        # 新一輪更新:清掉上一輪的信息位,避免 health 一直掛舊話。
        self._self_update_notice = None
        if isinstance(self._last_error, str) and self._last_error.startswith(
            ("self_update failed:", "更新安裝失敗", "更新失敗:")
        ):
            self._last_error = None
        print("· 收到 self_update → 驗證發布簽名…", file=sys.stderr)
        try:
            import tempfile
            import urllib.request

            import release_verify as rv

            base = os.environ.get(
                "MACCHIATO_RELEASE_BASE",
                "https://raw.githubusercontent.com/macchiato-chat/macchiato/main",
            )

            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, req, fp, code, msg, headers, newurl):
                    return None

            opener = urllib.request.build_opener(NoRedirect)

            def fetch(path: str, maximum: int) -> bytes:
                url = f"{base}/{path}"
                if not url.startswith("https://"):
                    raise ValueError(f"拒絕非 https:{url}")
                with opener.open(url, timeout=30) as r:  # noqa: S310  # https + 禁 redirect
                    if r.getcode() != 200 or r.geturl() != url:
                        raise ValueError(f"拒絕 redirect/非 200:{url}")
                    declared = r.headers.get("Content-Length")
                    if declared is not None and (not declared.isdigit() or int(declared) > maximum):
                        raise ValueError(f"HTTP body 超過 {maximum} bytes:{url}")
                    body = r.read(maximum + 1)
                    if len(body) > maximum:
                        raise ValueError(f"HTTP body 超過 {maximum} bytes:{url}")
                    return body

            manifest_bytes = fetch("release.json", 1024 * 1024)
            m = rv.verify_manifest(
                manifest_bytes,
                fetch("release.json.sig", 1024).decode("ascii"),
            )
            rv.check_self_update_allowed(m, CONNECTOR_VERSION)
            install_sh = fetch("install.sh", 2 * 1024 * 1024)
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
            env = _build_installer_env(dict(os.environ), mf_path)
            # detached：脫離本進程，免得服務重啟殺自己時把更新也中斷
            child = subprocess.Popen(
                ["/bin/bash", "-p", sh_path],
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            version = m["version"]

            def watch_installer() -> None:
                # #773 計時**從 installer 退出算起,不是從 spawn 算起**——安裝本身可能很久,
                # 從 spawn 起算等於在 installer 還在跑的時候放閂,會同時跑兩個 installer。
                self._on_installer_exit(child.wait(), version)

            threading.Thread(target=watch_installer, daemon=True).start()
        except Exception as exc:
            self._self_update_started = False
            print(f"[self_update failed] {exc!r}", file=sys.stderr)
            self._last_error = f"self_update failed: {exc}"

    def _on_installer_exit(
        self, code: int, version: str, grace_s: float | None = None
    ) -> None:
        """#773/#791 installer 進程退出後的收尾（在 watch_installer 線程裡跑，會阻塞 grace_s）。

        - 退出**非 0**（裝失敗）：立刻放閂 + 寫 lastError，用戶點重試就能真的再裝一次。
        - 退出 **0**（裝成功）：**不立刻**放閂——正常情況下服務重啟會把本進程殺掉，閂跟着進程
          一起消失。**立刻**掛「等待重啟」(#791:client 看門狗期間要能讀到真狀態)；grace_s
          後本進程還活着，才說明重啟沒生效 → 放閂 + 改成「重啟後生效」。

        🚨 那句話**絕不能說成「更新失敗」**：非 systemd（手動跑）本來就是「只更新文件、下次
        重啟生效」，那是正常路徑；說成失敗就是撒謊。只說事實 + 下一步。
        """
        if code != 0:
            self._self_update_started = False
            self._self_update_notice = None
            self._last_error = (
                f"更新安裝失敗(退出碼 {code})，可重試；若反复失敗請在終端重跑安裝命令"
            )
            print(f"[self_update failed] installer exit {code}", file=sys.stderr)
            return
        # #768:磁盤已是新版——寫標記供 health.installedVersion / server pendingRestart。
        _note_installed_version_on_disk(version)
        # #791:裝成功當下就讓 health 能說出「在等重啟」——client 不必乾等到 grace/看門狗。
        self._self_update_notice = f"更新已安裝(v{version})，等待連接器重啟…"
        time.sleep(_SELF_UPDATE_RESTART_GRACE_S if grace_s is None else grace_s)
        self._self_update_started = False
        self._self_update_notice = f"更新已下載(v{version}),重啟連接器後生效"
        print(
            f"· self_update:v{version} 已裝好,但本進程仍在跑——服務沒被重啟替換,"
            "放開更新閂(下次 self_update 會真的再裝一次)",
            file=sys.stderr,
        )

    def _heartbeat(self) -> dict:
        """#669 supervisor 面的運維字段（四家統一，TS 側單源於 connector-core/heartbeat.ts）。

        為什麼要有：`macchiato-supervise`（#528）只認崩潰循環；連接器「進程活著、但連不上 server」
        時它完全看不見（穩定存活 ≥60s 就清失敗計數）。而連不上 = 收不到 `self_update` = 自己爬不
        出來（#669 / #210）。supervisor 絕不能 import 連接器樹，所以唯一乾淨的接口是這個文件。

        🚨 只放運維字段：絕不寫入憑據 / token / 用戶會話內容（文件落盤、會被人看到）。
        """
        return {
            "version": CONNECTOR_VERSION,  # = connectorVersion，給不認識那個名字的 supervisor 用
            "linkConnected": self._linkb_state == "connected",
            "lastConnectedAt": int(self._linkb_connected_at) if self._linkb_connected_at else None,
            "busy": bool(self._live_inflight),
            "pendingApproval": bool(self._plain_approvals) or any(self._e2e_approvals.values()),
            "installId": _read_or_create_install_id(),
        }

    def _write_health_file(self, h: dict) -> None:
        """落盤 = `connector_health` 上報體 ⊕ 運維字段。

        上報體部分原樣保留（向後兼容既有消費者 / 本機 inspect）；**只擴文件、不擴 wire**——
        `connector_health` 幀的形狀一個字節都沒動。寫失敗永不上拋：心跳是觀測面，
        寫不出去只該讓 supervisor 判「未知」，不該把健康的連接器搞崩。
        """
        try:
            payload = json.dumps(
                {**h, **self._heartbeat(), "ts": int(time.time())}, ensure_ascii=False, indent=2
            )
            os.makedirs(os.path.dirname(HEALTH_FILE), exist_ok=True)
            for path in (HEALTH_FILE, HEALTH_FILE_KIND):
                tmp = path + ".tmp"
                with open(tmp, "w") as f:
                    f.write(payload)
                os.replace(tmp, path)
        except Exception as exc:
            print(f"[health file write failed] {exc!r}", file=sys.stderr)

    async def _health_loop(self) -> None:
        """每 HEALTH_INTERVAL_S：寫本地 health.json + 發 connector_health（讓 server 看出降級）。"""
        # #669 先落一次再進循環:本任務在 link B 撥號**之前**創建,所以連不上 server 的機器也會有
        # 一份「我活着、linkConnected=false」的證據——那正是 supervisor 唯一看得見的信號。
        # 等滿一個 HEALTH_INTERVAL_S 才首寫會留下 30s 的盲窗(重裝後尤其要緊)。
        self._write_health_file(self._health())
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

    def _pending_mirrors(self) -> list:
        st = self._mirror_st
        if st is None:
            return []
        pending = st.setdefault("pendingMirrors", [])
        if not isinstance(pending, list):
            st["pendingMirrors"] = []
            return st["pendingMirrors"]
        return pending

    def _find_pending_mirror(self, batch_id):
        if batch_id is None:
            return None
        want = str(batch_id)
        for pending in self._pending_mirrors():
            if isinstance(pending, dict) and str(pending.get("batchId")) == want:
                return pending
        return None

    def _drop_pending_mirror(self, batch_id) -> None:
        want = str(batch_id)
        pending = self._pending_mirrors()
        self._mirror_st["pendingMirrors"] = [
            p for p in pending if not (isinstance(p, dict) and str(p.get("batchId")) == want)
        ]
        self._mirror_sent_at.pop(want, None)
        self._mirror_sent_at.pop(batch_id, None)

    def _commit_pending_watermarks(self, pending: dict) -> None:
        """把 durable 批的候選水位/標題提交到已確認狀態（ACK 或 malformed 跳過）。"""
        st = self._mirror_st
        wm = st.setdefault("sessions", {})
        titles = st.setdefault("titles", {})
        ta = st.setdefault("touched_at", {})
        now = int(time.time())
        for sid, new_wm in (pending.get("watermarks") or {}).items():
            if not isinstance(sid, str) or not isinstance(new_wm, int):
                continue
            if new_wm > wm.get(sid, 0):
                wm[sid] = new_wm
                ta[sid] = now
        for sid, title in (pending.get("titles") or {}).items():
            if isinstance(sid, str) and isinstance(title, str):
                titles[sid] = title

    def _mirror_handle_ack(self, batch_id) -> None:
        """mirror_ack：只有 server 事務已提交後才推水位（F-01 / #348）。"""
        if self._mirror_st is None or batch_id is None:
            return
        pending = self._find_pending_mirror(batch_id)
        if pending is None:
            return
        self._commit_pending_watermarks(pending)
        self._drop_pending_mirror(batch_id)
        self._mirror_error_sticky = False
        self._last_error = None
        self._save_mirror_state(self._mirror_st)
        print(f"· mirror_ack batch {batch_id}：水位線已提交")

    def _mirror_handle_nack(self, batch_id, error: str | None = None, code: str | None = None) -> None:
        """mirror_nack（F-01 / #348 對齊 CC/Codex）。

        默認：保留 durable 批、同 batchId 重發（水位**不**回退——本來就還沒推）。
        終態 code：
          - e2e_direction：幀凍結在舊明/密文方向，重發永遠被拒 → 丟棄涉及會話的全部
            待確認批，水位停在最後一次 ACK，下輪 poll 重讀重編。
          - malformed：毒批/畸形，重試永遠不會好 → 丟批並**跳過**（推候選水位），否則
            該會話永不再前進；lastError 留給 health。
        """
        if self._mirror_st is None or batch_id is None:
            return
        target = self._find_pending_mirror(batch_id)
        if target is None:
            return
        self._count("mirrorNacks")  # #10
        self._last_error = error or f"mirror_nack: batch {batch_id}"
        self._mirror_error_sticky = True
        self._mirror_sent_at.pop(str(batch_id), None)
        self._mirror_sent_at.pop(batch_id, None)

        if code == "e2e_direction":
            # 水位鍵 = state.db sid；同 sid 後續凍結批同樣是舊方向 → 一併丟棄。
            sids = {
                sid
                for sid in (target.get("watermarks") or {})
                if isinstance(sid, str)
            }
            dropped = []
            kept = []
            for pending in self._pending_mirrors():
                if not isinstance(pending, dict):
                    continue
                p_wms = pending.get("watermarks") or {}
                same_batch = str(pending.get("batchId")) == str(batch_id)
                touches = bool(sids) and any(sid in sids for sid in p_wms)
                if same_batch or touches:
                    dropped.append(pending)
                    bid = pending.get("batchId")
                    self._mirror_sent_at.pop(str(bid), None)
                    self._mirror_sent_at.pop(bid, None)
                else:
                    kept.append(pending)
            self._mirror_st["pendingMirrors"] = kept
            self._count("mirrorDirectionRewinds")
            self._save_mirror_state(self._mirror_st)
            print(
                f"· mirror_nack(e2e_direction) batch {batch_id} → 丟棄 {len(dropped)} 個舊方向凍結批,"
                f"回退到已提交水位重讀重編",
                file=sys.stderr,
            )
            return

        if code == "malformed":
            # 毒批：跳過這段，否則會話永久卡死在無限重放。
            self._commit_pending_watermarks(target)
            self._drop_pending_mirror(batch_id)
            self._count("mirrorDropped")
            self._save_mirror_state(self._mirror_st)
            print(
                f"· mirror_nack(malformed) batch {batch_id} → 丟棄該批並跳過"
                f"(server 判畸形/毒批):{self._last_error}",
                file=sys.stderr,
            )
            return

        # transient / e2e_pending / 無 code（舊 server）：保留 outbox 重發。
        print(
            f"· mirror_nack batch {batch_id} → durable outbox retained for resend"
            + (f" (code={code})" if code else ""),
            file=sys.stderr,
        )

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

    def _sync_mirror_batch_id_from_pending(self) -> None:
        """重啟後 batch 計數器從 0 起；抬到 pending 最大 id，避免新批撞上未 ACK 的 batchId。"""
        max_id = int(getattr(self, "_mirror_batch_id", 0) or 0)
        for pending in self._pending_mirrors():
            bid = pending.get("batchId") if isinstance(pending, dict) else None
            if isinstance(bid, int) and bid > max_id:
                max_id = bid
            elif isinstance(bid, str) and bid.isdigit() and int(bid) > max_id:
                max_id = int(bid)
        self._mirror_batch_id = max_id

    async def _mirror_loop(self) -> None:
        """tail state.db：把其他渠道（Discord/Telegram/…）的新消息 mirror_append 給 server。"""
        st = self._mirror_st = self._load_mirror_state()
        self._sync_mirror_batch_id_from_pending()
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

    async def _resend_pending_mirrors(self, *, force: bool = False) -> bool:
        """重發 durable outbox 中未 ACK 的 mirror_append。返回是否仍有待確認批。

        force=True（ready 補發）忽略節流；日常 poll 按 MIRROR_RESEND_S 節流，對齊 CC 15s。
        """
        st = self._mirror_st
        if st is None:
            return False
        pending = self._pending_mirrors()
        if not pending:
            return False
        now = time.monotonic()
        for item in list(pending):
            if not isinstance(item, dict):
                continue
            frame = item.get("frame")
            bid = item.get("batchId")
            if not isinstance(frame, dict) or bid is None:
                continue
            key = str(bid)
            last = self._mirror_sent_at.get(key, 0.0)
            if not force and last and (now - last) < MIRROR_RESEND_S:
                continue
            ok = await self._send(frame)
            if ok:
                self._mirror_sent_at[key] = now
            else:
                self._count("mirrorSendFailed")
        return bool(self._pending_mirrors())

    async def _mirror_poll_once(self, st, baseline, wm, titles) -> None:
        # F-01 / #348：有未 ACK 批時只重發 outbox、不造新批——水位未提交，重讀會再造一份
        # 不同 batchId 的重複內容；凍結幀必須原樣重投直到 ACK / 終態 NACK。
        if await self._resend_pending_mirrors():
            return
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
            protected = self._e2e.is_protected(pid)
            if protected and not self._e2e.is_e2e(pid):
                # server-positive floor 已落盘但本机没有 K_S：宁可保留水位、反复告警，
                # 也不能把历史按非 E2E 明文镜像出去。
                print(
                    f"[E2E mirror quarantined {pid}] protected session has no K_S",
                    file=sys.stderr,
                )
                continue
            e2e = protected  # §19：E2E 會話走加密鏡像（方案 A），不跳過
            if (
                sid in self._rev
                or sid in self._fwd
                or sid in self._stored_rev
                # #656 收到 prompt.submit 起就算「本端驅動中」——上面三張表要等 _ensure_session
                # 跑完才有,那段窗口正是雙投的來源(見 self._driving 的註)。
                or self._is_driving(sid)
            ) and not e2e:
                # 續聊 Discord 會話（source=discord，經 tui 驅動）：運行時 id ≠ 持久化 id、消息落
                # 持久化 id 下、鏡像看到的是它，故連 _fwd 一起查,否則重複投遞。macchiato 新建會話
                # （source=tui，_stored_rev 鍵）由 live 路徑獨佔投遞，同樣跳過。
                continue
            if sid in self._srcid_pending:
                # #601 該會話的 srcId 回填在途(≤10s):此刻投出去會和 live 行撞成兩條。
                # 不推水位、不入 batch,下一輪(2s)再看——回填落地後同源行被唯一索引吃掉。
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
            # #592 豁免只給**已建立**的會話(自驅映射 pid≠sid / 已鏡像過 sid in wm)——E2E 下
            # 新冒出來的 skip 源(subagent 子會話/system…)不因加密而獲得建會話權,否則父會話
            # 每跑一次子代理就多一個獨立會話(2026-07-31 實踩,兩個 subagent = 兩個殭屍會話)。
            established = (pid != sid) or (sid in wm)
            if not keepable(source, title) and not (e2e and established):
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
            frame = {
                "t": "mirror_append",
                "agentLinkId": self.agent_link_id,
                "batchId": bid,
                "sessions": batch,
            }
            # F-01：幀先入 durable outbox 再發；只有 mirror_ack 才提交水位/標題。
            pending = {
                "batchId": bid,
                "frame": frame,
                "watermarks": dict(touched),
                "titles": dict(title_updates),
            }
            self._pending_mirrors().append(pending)
            self._save_mirror_state(st, strict=True)
            ok = await self._send(frame)
            if not ok:
                # #239:批根本沒到 server → outbox 已落盤,水位不推;下輪/重連原 batchId 重發。
                self._count("mirrorSendFailed")
                print(
                    f"[mirror batch {bid} 未發出 → durable outbox 保留,水位線不推進,下輪重試]",
                    file=sys.stderr,
                )
                return
            self._mirror_sent_at[str(bid)] = time.monotonic()
            n = sum(len(s["messages"]) for s in batch)
            self._count("mirrorBatches")  # #10
            self._count("mirrorMessages", n)
            nt = sum(1 for s in batch if not s["messages"])
            extra = f"（含 {nt} 純標題更新）" if nt else ""
            print(f"· 鏡像 {len(batch)} 會話 / {n} 條 → server (batch {bid}, awaiting ack){extra}")

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

    def _begin_e2e_transition(
        self, server_sid: str, mode: str, request_id: str | None = None
    ) -> None:
        if not hasattr(self, "_e2e_quiescing"):
            self._e2e_quiescing = {}
        self._e2e_quiescing[server_sid] = (mode, request_id)

    def _release_e2e_quiesce(
        self, server_sid: str, mode: str | None = None, request_id: str | None = None
    ) -> None:
        active = getattr(self, "_e2e_quiescing", {}).get(server_sid)
        if active is None:
            return
        if mode is not None and active[0] != mode:
            return
        if request_id is not None and active[1] not in (None, request_id):
            return
        self._e2e_quiescing.pop(server_sid, None)

    def _spawn_quiesce_task(self, server_sid: str, mode: str, request_id: str) -> None:
        """把 quiesce 自旋丟到後台任務並在其完成時回 result;接收循環不阻塞(見調用點註釋)。
        屏障在**這裡同步**先立起來(而不是等任務被調度),否則 server 發完 e2e_quiesce 立刻放行的
        新回合會從屏障底下溜過去。"""
        self._begin_e2e_transition(server_sid, mode, request_id)

        async def run() -> None:
            try:
                ok = await self._quiesce_e2e(server_sid, mode, request_id)
                error = None if ok else "busy_timeout"
            except Exception as exc:  # 任務內崩了也必須回 result,否則 server pendingOp 永遠掛著
                print(f"[E2E quiesce 失敗 {server_sid}] {exc!r}", file=sys.stderr)
                self._release_e2e_quiesce(server_sid, mode, request_id)
                ok, error = False, "quiesce_failed"
            try:
                await self._send(
                    {
                        "t": "e2e_quiesce_result",
                        "agentLinkId": self.agent_link_id,
                        "hermesSessionId": server_sid,
                        "mode": mode,
                        "requestId": request_id,
                        "ok": ok,
                        **({} if ok else {"error": error}),
                    }
                )
            except Exception as exc:
                print(f"[E2E quiesce result 發送失敗 {server_sid}] {exc!r}", file=sys.stderr)

        task = asyncio.ensure_future(run())
        tasks = getattr(self, "_quiesce_tasks", None)
        if tasks is None:
            tasks = self._quiesce_tasks = set()
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    async def _quiesce_e2e(
        self, server_sid: str, mode: str, request_id: str
    ) -> bool:
        self._begin_e2e_transition(server_sid, mode, request_id)
        deadline = asyncio.get_running_loop().time() + QUIESCE_TIMEOUT_S
        while (
            server_sid in self._live_inflight
            or server_sid in self._session_chains
            or server_sid in self._retry_tasks
        ):
            if asyncio.get_running_loop().time() >= deadline:
                self._release_e2e_quiesce(server_sid, mode, request_id)
                return False
            await asyncio.sleep(0.02)
        return True

    async def _resend_pending_e2e_backfills(self) -> None:
        st = getattr(self, "_mirror_st", None) or self._load_mirror_state()
        self._mirror_st = st
        for pending in list(st.setdefault("pendingE2EBackfills", {}).values()):
            frame = pending.get("frame") if isinstance(pending, dict) else None
            if isinstance(frame, dict):
                await self._send(frame)

    async def _e2e_backfill_history(self, server_sid: str, mode: str = "enable") -> None:
        """§19 D2 / 關閉：state.db 全量歷史回灌 `e2e_backfill`，server 事務內原地替換。
        mode="enable"（新開啟）：K_S 重加密回灌，清 KEK 可解的舊明文 payload。
        mode="disable"（關閉）：**明文**回灌（server 恢復可讀+投影）、成功後刪本地 K_S。
        找不到 state.db 會話（自驅 tui 會話 id 未解析，見 E2E-5）→ found:false：enable 時
        server 歷史不替換（僅新消息加密）；disable 時關閉失敗、K_S 保留、會話保持加密。
        持 _mirror_lock 與鏡像輪詢互斥。候選水位線與完整 wire frame 先持久化；只有收到
        server 對同一 batchId 的提交 ACK 後才推水位。斷線/進程重啟只重發同一批，不會
        因「已發出但未提交」跳過歷史。"""
        async with self._get_mirror_lock():
            st = self._mirror_st or self._load_mirror_state()
            self._mirror_st = st
            pending_all = st.setdefault("pendingE2EBackfills", {})
            existing = pending_all.get(server_sid)
            if isinstance(existing, dict) and existing.get("mode") == mode:
                frame = existing.get("frame")
                if isinstance(frame, dict):
                    await self._send(frame)
                    return
            snap, state_sid = await self._e2e_snapshot(server_sid)
            if snap is None or not snap["messages"]:
                batch_id = str(uuid.uuid4())
                frame = {
                    "t": "e2e_backfill",
                    "agentLinkId": self.agent_link_id,
                    "hermesSessionId": server_sid,
                    "mode": mode,
                    "found": False,
                    "batchId": batch_id,
                }
                pending_all[server_sid] = {
                    "batchId": batch_id,
                    "mode": mode,
                    "frame": frame,
                    "stateSid": None,
                    "cover": None,
                }
                self._save_mirror_state(st, strict=True)
                await self._send(frame)
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
            backfill = {
                "t": "e2e_backfill",
                "agentLinkId": self.agent_link_id,
                "hermesSessionId": server_sid,
                "mode": mode,
                "found": True,
                "session": entry,
                "batchId": str(uuid.uuid4()),
            }
            if mode == "disable":
                # 关闭回灌会把 plaintext 交给不可信 server。先为设备签名 intent 生成
                # connector-authenticated release receipt 并和 K_S 原子落盘；只有之后才允许
                # plaintext 离开本机。重试必须复用同一 receipt，不能生成第二份模糊结算状态。
                pending = self._e2e.pending_disable(server_sid)
                if pending is None:
                    raise E2EControlError(
                        "disable backfill has no authenticated durable intent"
                    )
                receipt = pending["receipt"]
                if receipt is None:
                    receipt = create_disable_receipt(
                        self._e2e.require_key(server_sid),
                        pending["intent"],
                    )
                    self._e2e.save_disable_receipt(server_sid, receipt)
                else:
                    verify_disable_receipt(
                        self._e2e.require_key(server_sid),
                        receipt,
                        expected_intent=pending["intent"],
                    )
                backfill["disableReceipt"] = receipt
            pending_all[server_sid] = {
                "batchId": backfill["batchId"],
                "mode": mode,
                "frame": backfill,
                "stateSid": state_sid,
                "cover": snap["cover"],
            }
            # #367 WAL：先以原子 replace 持久化 outbox/candidate，再允許 frame 離機。
            self._save_mirror_state(st, strict=True)
            await self._send(backfill)
            print(
                f"· E2E 回灌({mode})：{server_sid} 全歷史 {len(snap['messages'])} 條已回傳"
                f"（候選水位線 {snap['cover']}，等待 ACK）"
            )

    async def _submit_final(self, server_sid: str, real: str, final_text: str, retry_refs: list) -> None:
        """提交一回合文本給 gateway(prompt.submit 與 #199 command.invoke 共用尾段):
        #13 記回合 floor → submit;GatewayDied → 後台重投(#4);4009 busy → steer 注入(#75 方案 D);
        成功 → 補償早到中斷(#5)。"""
        assert self.gw is not None
        # #13:記回合 floor——此後 > floor 的 state.db 行即本回合所寫,
        # 回合結束(message.complete)按它定位行 id 回填 live 消息身份。
        if self._db_sid(server_sid) and not self._e2e.is_protected(server_sid):
            try:
                self._turn_floor[server_sid] = await current_max_id()
            except Exception:
                pass  # 拿不到 floor → 本回合不回填,會話級跳過照舊兜底
        # #559:Hermes 0.19 起 tui_gateway **不再**對回合中的 prompt.submit 回 4009,而是按
        # `display.busy_input_mode`(默認 `interrupt`)自行處置——掛在 4009 上的 steer 分支成了
        # 死代碼,語義悄悄從「注入同一回合」變成由上游決定的 redirect/硬打斷,且狗糧機 2026-07-31
        # 實測到跟進消息**整條消失**(用戶按了發送、氣泡也上去了,agent 沒收到,無任何一層報錯)。
        # 改為**連接器自己判回合中**(openclaw 同款,不依賴上游錯誤碼):`_live_inflight` 由
        # message.start/complete 維護,本就是簽封 interrupt 判「正在運行」用的同一份本地事實。
        # steer 未命中(回合恰好剛結束 / 上游不支持)→ 回退 submit_prompt,消息絕不丟。
        # 純附件無文字無法 steer(steer 只吃文本)→ 也走 submit_prompt。
        if final_text and server_sid in self._live_inflight:
            try:
                res = await self.gw.steer(real, final_text)
                # ⚠️ 回歸契約:scripts/regression/README.md 掛號,run-live-smoke.mjs hermes 斷言此串
                print(f"· 回合進行中 → steer 注入跟進消息（status={(res or {}).get('status')}）")
                return
            except Exception as exc:
                print(
                    f"[#559 steer 未命中 → 回退 submit_prompt {server_sid}] {exc!r}",
                    file=sys.stderr,
                )
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
            # 舊 Hermes(< 0.19)兜底:那時回合中的 submit 會回 4009 session busy,據此 steer 注入
            # (#75 方案 D)。0.19 起主路徑已改為上面的 `_live_inflight` 前置判定(#559),此分支只
            # 覆蓋「回合剛開始、message.start 還沒到」的窄窗與舊版本。純圖無文字無法 steer → 上拋。
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
    # 只碰 AGENTS.md 一個文件;#378 文件原語抗 symlink/TOCTOU(見上方 _proj_read_named/_proj_write_named:
    # 目錄 realpath+dev/ino 釘身份、目標 O_NOFOLLOW+fstat、寫走同目錄隨機臨時名 O_EXCL);
    # CLAUDE.md 墊片只在不存在時補(不踩用戶配置)。self._projects 值為可信目錄身份 dict。

    def _projects_load(self) -> None:
        try:
            with open(_projects_reg_path()) as f:
                data = json.load(f)
            for sp in data.get("paths", []):
                try:
                    self._projects[sp] = _proj_dir_identity(sp)  # #378 realpath+dev/ino;不存在/非目錄跳過
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
                        self._projects[sp] = _proj_dir_identity(sp)  # #378 realpath+dev/ino;壞路徑跳過
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
        canon_raw = os.path.realpath(os.path.expanduser(server_path))
        existed = os.path.exists(canon_raw)
        if not existed:
            if not mkdir:
                return {"ok": False, "error": f"目錄不存在:{canon_raw}(可勾選「自動創建」)"}
            os.makedirs(canon_raw, exist_ok=True)
        # #378 realpath + dev/ino 釘身份(擋目錄 symlink);非目錄 → 統一回不是目錄。
        try:
            ident = _proj_dir_identity(server_path)
        except Exception:
            return {"ok": False, "error": f"不是目錄:{canon_raw}"}
        canon = ident["canon"]
        if not os.access(canon, os.W_OK):
            return {"ok": False, "error": f"目錄不可寫:{canon}"}
        # #378 符號連結:解析到項目樹內的真實文件 → 當常規文件照常用(dotfiles 用 symlink 管 CLAUDE.md
        # 的用戶不受影響);指到項目目錄外(或斷鏈)→ _proj_named_kind 拋錯,由 _project_op 統一回錯。
        a_kind = _proj_named_kind(ident, "AGENTS.md")
        c_kind = _proj_named_kind(ident, "CLAUDE.md")
        # 三態(同 TS): (A) 有 AGENTS.md 沿用; (B) 只有 CLAUDE.md 無 AGENTS.md → 遷移(內容落 AGENTS.md+重建墊片),
        # 超過 PROJ_MEM_MAX 則整體拒絕備案(寧可不備案,也不能截斷丟用戶內容);
        # (C) 都無/CLAUDE.md 已是純墊片 → 帶初始內容則寫 AGENTS.md,缺墊片補。
        existing = None
        wrote_shim = False
        migrated = False
        if a_kind == "file":
            existing = _proj_read_named(ident, "AGENTS.md", PROJ_MEM_MAX)
            if c_kind == "absent":
                _proj_write_named(ident, "CLAUDE.md", PROJ_SHIM)
                wrote_shim = True
        elif c_kind == "file":
            # 超限的 CLAUDE.md 絕不能遷移:照讀會拿到**截斷版**,落進 AGENTS.md 後原文件被覆蓋成一行墊片,
            # 超出 PROJ_MEM_MAX 的部分永久丟。故先量大小,超限 → 拒絕備案,磁盤一個字節都不動。
            c_size = _proj_named_size(ident, "CLAUDE.md") or 0
            if c_size > PROJ_MEM_MAX:
                return {"ok": False,
                        "error": f"CLAUDE.md 超過 {PROJ_MEM_MAX // 1024}KB 記憶上限({c_size} 字節),"
                                 f"為避免截斷丟失內容已拒絕遷移;請先精簡 CLAUDE.md 再備案"}
            c_content = _proj_read_named(ident, "CLAUDE.md", PROJ_MEM_MAX) or ""
            if c_content.strip() != "@AGENTS.md":
                _proj_write_named(ident, "AGENTS.md", c_content)  # (B) 內容落 AGENTS.md
                _proj_write_named(ident, "CLAUDE.md", PROJ_SHIM)  # 重建一行墊片
                existing = c_content
                wrote_shim = True
                migrated = True
            elif agents_md is not None:
                _proj_write_named(ident, "AGENTS.md", agents_md)  # CLAUDE.md 已是純墊片
        else:
            if agents_md is not None:
                _proj_write_named(ident, "AGENTS.md", agents_md)
            _proj_write_named(ident, "CLAUDE.md", PROJ_SHIM)
            wrote_shim = True
        content = existing if existing is not None else (agents_md or "")
        self._projects[server_path] = ident
        self._proj_last_hash[canon] = _mem_hash(content)
        self._projects_save()
        tag = "(CLAUDE.md→AGENTS.md 遷移)" if migrated else ("(+CLAUDE.md 墊片)" if wrote_shim else "")
        print(f"· #227 project 備案:{server_path}{tag}")
        return {"ok": True, "existed": existed, "agentsMd": existing, "hash": _mem_hash(content),
                "wroteShim": wrote_shim, "migratedClaudeToAgents": migrated}

    def _proj_require(self, server_path: str) -> dict:
        ident = self._projects.get(server_path)
        if not ident:
            raise ValueError("路徑未備案(本地註冊表硬校驗)")
        return ident

    @staticmethod
    def _proj_file_for(file) -> str:
        """#227 具名文件白名單:AGENTS.md(默認,記憶)| CLAUDE.md(修墊片用)。其餘一律拒。"""
        if file is None or file == "AGENTS.md":
            return "AGENTS.md"
        if file == "CLAUDE.md":
            return "CLAUDE.md"
        raise ValueError(f"文件不在白名單:{file}")

    def _proj_mem_read(self, server_path: str, file=None) -> dict:
        ident = self._proj_require(server_path)
        name = self._proj_file_for(file)
        content = _proj_read_named(ident, name, PROJ_MEM_MAX) or ""  # #378 O_NOFOLLOW+fstat
        if name == "AGENTS.md":
            self._proj_last_hash[ident["canon"]] = _mem_hash(content)
        return {"ok": True, "agentsMd": content, "hash": _mem_hash(content)}

    def _proj_mem_write(self, server_path: str, content, file=None) -> dict:
        ident = self._proj_require(server_path)
        name = self._proj_file_for(file)
        # 上限一律按**字節**量:讀路徑按字節截,寫路徑若按字符數擋,非 ASCII 內容會出現
        # 「寫得進、讀回是截斷版、回合末 hash 一變就用截斷版覆蓋 server」的丟數據循環。
        if content is None or len(content.encode("utf-8")) > PROJ_MEM_MAX:
            return {"ok": False, "error": "內容缺失或超限"}
        _proj_write_named(ident, name, content)  # #378 同目錄隨機臨時名 O_EXCL+rename
        if name == "AGENTS.md":
            self._proj_last_hash[ident["canon"]] = _mem_hash(content)
        return {"ok": True, "hash": _mem_hash(content)}

    def _projects_check_turn_end(self) -> None:
        """#227 回合末惰性版本化:掃備案目錄(極少)的 AGENTS.md,hash 變了 → 推 project_mem_changed。
        未定基線(重啟後首回合)只定不推——重啟間隙的變化由面板打開時的穿透讀對賬兜住。"""
        for server_path, ident in list(self._projects.items()):
            try:
                content = _proj_read_named(ident, "AGENTS.md", PROJ_MEM_MAX) or ""
                h = _mem_hash(content)
                prev = self._proj_last_hash.get(ident["canon"])
                self._proj_last_hash[ident["canon"]] = h
                if prev is not None and prev != h:
                    asyncio.get_running_loop().create_task(self._send({
                        "t": "project_mem_changed", "agentLinkId": self.agent_link_id,
                        "path": server_path, "content": content, "hash": h,
                    }))
                    print(f"· #227 AGENTS.md 變更 → 落版本({server_path})")
            except Exception:
                pass  # 單目錄壞不擋其餘

    def _dispatch_session(self, server_sid: str, coro_factory, *, propagate: bool = False):
        """#148:把慢工作掛到該會話的串行鏈上。讀循環立刻返回;同會話按序、跨會話並發。
        前任異常不斷鏈(已各自記日誌/計數);鏈尾完成且仍是尾 → 清條目防字典緩慢積長。

        #370 的認證控制必須等真實副作用完成後才 ACK，因此可要求把當前任務異常重新拋給
        `_on_server_msg`；普通 prompt/非 E2E 控制仍保持既有 fire-and-forget 行為。
        """
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
                if propagate:
                    raise

        task = asyncio.create_task(run())
        self._session_chains[server_sid] = task

        def _cleanup(t):
            if self._session_chains.get(server_sid) is t:
                self._session_chains.pop(server_sid, None)

        task.add_done_callback(_cleanup)
        return task

    @staticmethod
    def _json_depth_ok(value, max_depth: int, depth: int = 0) -> bool:
        if depth > max_depth:
            return False
        if value is None or not isinstance(value, (dict, list)):
            return True
        if isinstance(value, list):
            return all(Connector._json_depth_ok(item, max_depth, depth + 1) for item in value)
        return all(Connector._json_depth_ok(v, max_depth, depth + 1) for v in value.values())

    @staticmethod
    def _is_sane_inbound(msg) -> bool:
        """#380 入站基本邊界：type/鍵數/深度/關鍵 id/批次數組。未知 t 放行但受頂層約束。"""
        if not isinstance(msg, dict):
            return False
        if len(msg) > LINKB_MAX_TOP_LEVEL_KEYS:
            return False
        t = msg.get("t")
        if not isinstance(t, str) or not t or len(t) > LINKB_MAX_TYPE_LEN:
            return False
        if not Connector._json_depth_ok(msg, LINKB_MAX_JSON_DEPTH):
            return False
        for key in ("sessionId", "hermesSessionId", "chatId", "agentLinkId"):
            v = msg.get(key)
            if v is not None and (not isinstance(v, str) or len(v) > LINKB_MAX_SESSION_ID_LEN):
                return False
        frame = msg.get("frame")
        if frame is not None:
            if not isinstance(frame, dict):
                return False
            params = frame.get("params")
            if params is not None:
                if not isinstance(params, dict):
                    return False
                sid = params.get("session_id")
                if sid is not None and (
                    not isinstance(sid, str) or len(sid) > LINKB_MAX_SESSION_ID_LEN
                ):
                    return False
        for key in ("sessions", "items", "messages", "disabledReceipts"):
            v = msg.get(key)
            if isinstance(v, list) and len(v) > LINKB_MAX_BULK_ARRAY_LEN:
                return False
        e2e = msg.get("e2eState")
        if e2e is not None:
            if not isinstance(e2e, dict):
                return False
            sessions = e2e.get("sessions")
            receipts = e2e.get("disabledReceipts")
            if isinstance(sessions, list) and len(sessions) > LINKB_MAX_BULK_ARRAY_LEN:
                return False
            if isinstance(receipts, list) and len(receipts) > LINKB_MAX_BULK_ARRAY_LEN:
                return False
        return True

    async def _on_server_msg(self, raw) -> None:
        if isinstance(raw, (bytes, bytearray, memoryview)):
            nbytes = len(raw)
        elif isinstance(raw, str):
            nbytes = len(raw.encode("utf-8"))
        else:
            nbytes = len(str(raw).encode("utf-8"))
        if nbytes > LINKB_MAX_FRAME_BYTES:
            print(
                f"[Link B inbound dropped] {nbytes} bytes > maxPayload",
                file=sys.stderr,
            )
            return
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            print("[Link B inbound dropped] invalid JSON", file=sys.stderr)
            return
        if not self._is_sane_inbound(msg):
            print(
                f"[Link B inbound dropped] schema/size bounds (t={msg.get('t')!r})",
                file=sys.stderr,
            )
            return
        t = msg.get("t")
        if not self._linkb_ready and t not in ("ready", "auth_error", "ping"):
            # 在 ready E2E snapshot 验证并把 positive floor 持久化以前，任何业务帧都
            # 不能进入 legacy 路径；畸形 ready 后同一恶意连接继续发帧也一律丢弃。
            print(f"[pre-ready frame rejected] {t!r}", file=sys.stderr)
            return
        if t == "ready":
            # #370：disable backfill 的提交 ACK 可能在断线中丢失。server 的 e2e:false 或
            # ready omission 都不是可信降级证明；只有当前 K_S 能验过、且与本地 durable
            # intent/release 完全相同的 connector receipt 才能结算并删除 K_S。
            state = msg.get("e2eState")
            try:
                if not isinstance(state, dict) or state.get("version") != 1:
                    raise ValueError("missing/invalid e2eState")
                rows = state.get("sessions")
                if not isinstance(rows, list):
                    raise ValueError("invalid e2eState sessions")
                server_e2e: dict[str, str | None] = {}
                for row in rows:
                    if (
                        not isinstance(row, dict)
                        or set(row) != {"hermesSessionId", "pendingOp"}
                        or not isinstance(row.get("hermesSessionId"), str)
                        or not row["hermesSessionId"]
                        or row.get("pendingOp") not in (None, "enable", "disable")
                        or row["hermesSessionId"] in server_e2e
                    ):
                        raise ValueError("invalid/duplicate e2eState session")
                    server_e2e[row["hermesSessionId"]] = row["pendingOp"]
                self._e2e_quiescing = {
                    sid: (op, None)
                    for sid, op in server_e2e.items()
                    if op in ("enable", "disable")
                }
                receipts = state.get("disabledReceipts")
                if not isinstance(receipts, list):
                    raise ValueError("invalid e2eState disabledReceipts")
                receipt_by_sid: dict[str, dict] = {}
                exact_receipt_keys = {
                    "v",
                    "kind",
                    "sessionId",
                    "hermesSessionId",
                    "keyId",
                    "intentDeviceId",
                    "intentMsgId",
                    "intentSeq",
                    "receiptId",
                    "mac",
                }
                for receipt in receipts:
                    if (
                        not isinstance(receipt, dict)
                        or set(receipt) != exact_receipt_keys
                        or not isinstance(receipt.get("hermesSessionId"), str)
                        or not receipt["hermesSessionId"]
                        or receipt["hermesSessionId"] in receipt_by_sid
                    ):
                        raise ValueError("invalid/duplicate disabled receipt")
                    validate_disable_receipt_shape(receipt)
                    receipt_by_sid[receipt["hermesSessionId"]] = receipt

                # 先单调持久化 server-positive floor，再处理 receipt / flush。即使本机 K_S
                # 已丢，后续 raw prompt/control/mirror 也只能 quarantine，绝不降到明文。
                pe_from_ready = {
                    sid for sid, op in server_e2e.items() if op == "enable"
                }
                self._e2e.protect_sessions(set(server_e2e), pending_enable=pe_from_ready)
                # #818：本地仍标 pending-enable、权威快照却省略 → enable 已被中止，按权威收敛。
                for sid in list(self._e2e.pending_enable_sessions()):
                    if sid not in server_e2e:
                        if self._e2e.abort_incomplete_enable(sid):
                            print(
                                f"· E2E #818 ready 对账：pending-enable {sid} 被权威省略，"
                                "已收敛为明文",
                                file=sys.stderr,
                            )
                # floor 提升前断线缓冲里可能已有 plaintext TUI/import；必须在任何 receipt
                # 结算和 ready flush 之前按“提升后的完整保护域”过滤。后续迟到 producer
                # 仍由 `_send` 的最终出站闸门逐帧重验。
                self._drop_queued_for_protected(
                    self._e2e.protected_session_ids()
                )
                completed: set[str] = set()
                for sid in self._e2e.pending_disable_sessions():
                    receipt = receipt_by_sid.get(sid)
                    pending = self._e2e.pending_disable(sid)
                    remote_op = server_e2e.get(sid)
                    try:
                        if remote_op == "enable":
                            # ACK 丢失后用户可能立刻重新开启：server 此时仍在同一 ready
                            # 中携 R1。只有本地 K1 能验过且与 durable release 完全一致的 R1
                            # 才允许退休 K1；随后保留 floor，wrap 必须生成全新的 K2。
                            if (
                                receipt is None
                                or pending is None
                                or pending["receipt"] != receipt
                            ):
                                raise ValueError(
                                    "pending re-enable has no matching authenticated disable receipt"
                                )
                            verify_disable_receipt(
                                self._e2e.require_key(sid),
                                receipt,
                                expected_intent=pending["intent"],
                            )
                            self._e2e.complete_disable_for_reenable(sid, receipt)
                            completed.add(sid)
                            continue
                        if receipt is None or pending is None or pending["receipt"] != receipt:
                            continue
                        if sid in server_e2e:
                            # stable E2E / pending-disable 与“旧 plaintext release 已提交”
                            # 同时出现是矛盾状态：隔离该 sid，不得关掉整条 link。
                            raise ValueError(
                                "disable receipt conflicts with active E2E server state"
                            )
                        verify_disable_receipt(
                            self._e2e.require_key(sid),
                            receipt,
                            expected_intent=pending["intent"],
                        )
                        self._e2e.complete_disable(sid, receipt)
                        completed.add(sid)
                    except Exception as exc:
                        # #817：单 sid receipt 冲突只隔离该会话（留 K_S、不结算 disable、
                        # 不铸 K₂），其余会话继续 ready。快照 shape 错误仍由外层 1008。
                        try:
                            self._e2e.protect_sessions({sid})
                        except Exception as protect_exc:
                            print(
                                f"[E2E ready isolate {sid}] protect_sessions: {protect_exc!r}",
                                file=sys.stderr,
                            )
                        print(
                            f"[E2E ready isolated {sid}] {exc}；"
                            "保留 K_S、不结算 disable、不铸 K₂，其余会话继续",
                            file=sys.stderr,
                        )
                if completed:
                    # 这些旧 epoch 已由 server 提交；断线期间缓存的旧密文/回灌帧不能再补发。
                    # re-enable 会话仍由 retained protection floor 保持隔离，直到生成 K2。
                    kept: list[str] = []
                    for pending_raw in self._out_pending:
                        try:
                            pending_msg = json.loads(pending_raw)
                        except Exception:
                            kept.append(pending_raw)
                            continue
                        pending_sid = pending_msg.get("hermesSessionId") or pending_msg.get("sessionId")
                        nested_sessions = pending_msg.get("sessions")
                        touches_completed = pending_sid in completed or (
                            isinstance(nested_sessions, list)
                            and any(
                                isinstance(item, dict)
                                and item.get("hermesSessionId") in completed
                                for item in nested_sessions
                            )
                        )
                        if not touches_completed:
                            kept.append(pending_raw)
                    self._set_out_pending(kept)
                    # ⚠️ ready 對賬已按認證 receipt 結算這些會話 → 它們的 durable disable
                    # backfill **也已經提交**。必須同步從 pendingE2EBackfills 摘掉，否則下面的
                    # `_resend_pending_e2e_backfills` 會把**完整明文快照 + receipt 再發一次**；
                    # 而 `e2e_backfill_result` 回來時本地 pending_disable 已是 None → raise →
                    # 被 `_on_server_msg` 的兜底 except 吞掉 → 結尾的 pop/save 永遠到不了 →
                    # 每次重連原樣重演，明文快照每次過線（#367 的「ACK 丟失可自動收斂」驗收項
                    # 反而變成永久錯誤迴圈）。
                    bst = getattr(self, "_mirror_st", None) or self._load_mirror_state()
                    self._mirror_st = bst
                    pending_backfills = bst.setdefault("pendingE2EBackfills", {})
                    settled_backfills = 0
                    for sid in completed:
                        entry = pending_backfills.get(sid)
                        if not isinstance(entry, dict) or entry.get("mode") != "disable":
                            continue
                        # 與正常 ACK 路徑一致：提交後推該會話的鏡像水位，別讓已回灌的段重投。
                        state_sid = entry.get("stateSid")
                        cover = entry.get("cover")
                        if isinstance(state_sid, str) and isinstance(cover, int):
                            wm = bst.setdefault("sessions", {})
                            if cover > wm.get(state_sid, 0):
                                wm[state_sid] = cover
                        pending_backfills.pop(sid, None)
                        self._release_e2e_quiesce(sid, "disable")
                        settled_backfills += 1
                    if settled_backfills:
                        self._save_mirror_state(bst, strict=True)
                    print(
                        f"· E2E disable ACK 丢失恢复：已按认证 receipt 结算 {len(completed)} 个会话"
                        + (
                            f"（同步摘除 {settled_backfills} 份已提交的待确认回灌，不再重发明文快照）"
                            if settled_backfills
                            else ""
                        )
                    )
            except Exception as exc:
                self._linkb_state = "e2e_state_error"
                self._last_error = "invalid E2E ready state"
                print(
                    f"[E2E ready rejected; no queued frame flushed] {exc!r}",
                    file=sys.stderr,
                )
                if getattr(self, "ws", None) is not None:
                    await self.ws.close(code=1008, reason="invalid E2E ready state")
                return
            self._linkb_state = "connected"
            self._linkb_connected_at = time.time()  # #669 心跳的 lastConnectedAt
            print("✓ link B ready — 連接器上線，等待 server 下達")
            if self._out_pending and getattr(self, "ws", None) is not None:
                n = len(self._out_pending)
                try:
                    # #251:先 peek 再 popleft——send 失敗時該幀不丟(此前 popleft 後 send 拋即丟一幀)。
                    while self._out_pending:
                        await self.ws.send(self._out_pending[0])
                        old = self._out_pending.popleft()
                        self._out_pending_bytes = max(
                            0, self._out_pending_bytes - len(old.encode("utf-8"))
                        )
                    print(f"· 重連 → 補發斷線期間積壓的 {n} 幀")
                except Exception as exc:
                    print(f"[積壓補發失敗,剩 {len(self._out_pending)}] {exc!r}", file=sys.stderr)
            # #251:補發完成後才置 ready——補發期間並發的 _send 走緩衝、由上面循環按序帶出,不亂序。
            self._linkb_ready = True
            # F-01：重連後立刻補發未 ACK 的 mirror_append（同 batchId；對齊 E2E backfill）。
            if self._mirror_st is None:
                self._mirror_st = self._load_mirror_state()
            await self._resend_pending_mirrors(force=True)
            await self._resend_pending_e2e_backfills()
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
            # #387 永久吊銷(app 解綁 kick 帶 "revoked";踢時離線的重連撞 "invalid connector
            # token")→ 隔離憑證 + exit 78:新版 unit RestartPreventExitStatus=78 不再拉起;
            # 舊 unit 重啟後因無憑證直接退出,不再拿死 token 打 server。
            r = str(reason or "")
            if r == "revoked" or "invalid connector token" in r:
                _quarantine_creds()
                print(
                    "✗ Unpaired from the Macchiato app — local credentials retired. "
                    "Re-run the install command to pair again.",
                    file=sys.stderr,
                )
                self._on_fatal_revoked()
                return
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
        if t == "mirror_ack":
            self._mirror_handle_ack(msg.get("batchId"))
            return
        if t == "mirror_nack":
            code = msg.get("code")
            self._mirror_handle_nack(
                msg.get("batchId"),
                error=msg.get("error") if isinstance(msg.get("error"), str) else None,
                code=code if isinstance(code, str) else None,
            )
            return
        if t == "self_update":
            self._self_update()
            return
        if (
            t == "e2e_quiesce"
            and isinstance(msg.get("hermesSessionId"), str)
            and msg.get("mode") in ("enable", "disable")
            and isinstance(msg.get("requestId"), str)
        ):
            sid = msg["hermesSessionId"]
            mode = msg["mode"]
            request_id = msg["requestId"]
            # ⚠️ 絕不 inline await:_quiesce_e2e 會自旋到在途回合收尾(上限 QUIESCE_TIMEOUT_S)。
            # 本函數跑在**單消費者接收循環**裡——inline await 期間該 agent link 上所有會話的
            # tui / mirror_nack / self_update、乃至 server 用來解鎖的 e2e_quiesce_release 全堵在
            # socket buffer 裡收不到,而 WS ping/pong 由庫的獨立任務答 → server 與 App 全程顯示
            # 連接器健康,實際整條 Link B 凍結數分鐘。對齊 OpenClaw(index.ts 的 void ...then())
            # 改成後台任務,接收循環立刻回去收下一幀。
            self._spawn_quiesce_task(sid, mode, request_id)
            return
        if (
            t == "e2e_quiesce_release"
            and isinstance(msg.get("hermesSessionId"), str)
            and msg.get("mode") in ("enable", "disable")
        ):
            self._release_e2e_quiesce(
                msg["hermesSessionId"], msg["mode"], msg.get("requestId")
            )
            return
        if t == "e2e_wrap_request":
            # §19：iOS 開啟某會話 E2E（backfill）可生成 K_S；新設備補封只能沿用既有钥。
            sid = msg.get("hermesSessionId")
            if sid:
                # 顯式拒絕 + 明確日誌，與 cc / codex / openclaw 的內層 catch 對稱
                # （#366 驗收項）。此前狀態級錯誤只會被主循環的通用 catch 吞成
                # 「_on_server_msg 分支異常」，運維無從分辨是畸形幀還是真故障。
                try:
                    enabling = bool(msg.get("backfill"))
                    pending = self._e2e.pending_disable(sid)
                    if enabling and pending is not None:
                        # disable 已提交但 ACK 丢失时，server 可能在同一连接上立刻收到用户
                        # re-enable，来不及经过下一次 ready 对账。此时绝不能 createForEnable
                        # 复用 K1；live 请求也必须携带并通过本地 K1 验证 R1，先原子退休旧
                        # epoch、保留 protection floor，随后才可生成 K2。
                        receipt = msg.get("disableReceipt")
                        if receipt != pending.get("receipt") or receipt is None:
                            raise E2EControlError(
                                "pending re-enable has no matching authenticated disable receipt"
                            )
                        verify_disable_receipt(
                            self._e2e.require_key(sid),
                            receipt,
                            expected_intent=pending["intent"],
                        )
                        self._e2e.complete_disable_for_reenable(sid, receipt)
                    # 只有 enable/backfill 可建钥；新设备补封缺 key 必须软拒绝，绝不铸 K₂。
                    if enabling:
                        wrapped = self._e2e.wrap_for_enable(sid, msg.get("devices") or [])
                    else:
                        wrapped = self._e2e.wrap_existing_for_devices(
                            sid, msg.get("devices") or []
                        )
                except (ValueError, E2EControlError) as exc:
                    # 軟拒絕該幀:不回 e2e_key、不動本地狀態、連接照常。
                    print(f"[E2E wrap rejected {sid}] {exc}", file=sys.stderr)
                    return
                # #731 未授權設備要讓用戶知道:跳過本身是靜默的,不回報就只剩永遠轉圈的 Updating。
                rejected = self._e2e.take_device_auth_rejections()
                await self._send({
                    "t": "e2e_key",
                    "agentLinkId": self.agent_link_id,
                    "hermesSessionId": sid,
                    "wrapped": wrapped,
                    **({"deviceAuthRejected": rejected} if rejected else {}),
                })
                print(f"· E2E：會話 {sid} 封裝 K_S 給 {len(wrapped)} 台設備")
                if msg.get("backfill"):
                    self._begin_e2e_transition(sid, "enable")
                    try:
                        self._e2e.mark_pending_enable(sid)
                    except Exception as exc:
                        print(f"[E2E pending-enable mark {sid}] {exc!r}", file=sys.stderr)
                    # §19 D2 新開啟：把該會話全量歷史重加密回灌，server 原地替換明文。
                    asyncio.create_task(self._e2e_backfill_history(sid))
            return
        if t == "e2e_enable_aborted":
            # #818 live 路径：server 权威中止 pending-enable（client abort / 设备授权全拒等）。
            sid = msg.get("hermesSessionId")
            if isinstance(sid, str) and sid:
                if self._e2e.abort_incomplete_enable(sid):
                    self._release_e2e_quiesce(sid, "enable")
                    print(
                        f"· E2E enable aborted (live): {sid} — K_S dropped, plaintext resumed"
                    )
                else:
                    print(
                        f"· E2E enable_aborted ignored for {sid}"
                        "（非 pending-enable，fail-closed 保留 K_S）",
                        file=sys.stderr,
                    )
            return
        if t == "e2e_disable_request":
            # 仅用于断线恢复：发起动作必须先经过 `session.e2e.disable` 设备签封，
            # 并在本地持久化 pending marker。server 单方面发裸帧绝不能触发明文回灌。
            sid = msg.get("hermesSessionId")
            if sid and self._e2e.has_pending_disable(sid):
                self._begin_e2e_transition(sid, "disable")
                asyncio.create_task(self._e2e_backfill_history(sid, mode="disable"))
            elif sid:
                print(
                    f"[E2E disable resume rejected {sid}] no authenticated local intent",
                    file=sys.stderr,
                )
                # server 可能因 ACK timeout 保守保留 pending；显式 found:false 让其安全清掉
                # pending、维持 e2e/K_S，用户随后可用新 seq 重试。绝不发送明文 snapshot。
                await self._send(
                    {
                        "t": "e2e_backfill",
                        "agentLinkId": self.agent_link_id,
                        "hermesSessionId": sid,
                        "mode": "disable",
                        "found": False,
                        "batchId": str(uuid.uuid4()),
                    }
                )
            return
        if t == "e2e_backfill_result":
            sid = msg.get("hermesSessionId")
            mode = msg.get("mode")
            st = getattr(self, "_mirror_st", None) or self._load_mirror_state()
            self._mirror_st = st
            pending_all = st.setdefault("pendingE2EBackfills", {})
            pending_backfill = pending_all.get(sid) if isinstance(sid, str) else None
            if (
                not isinstance(pending_backfill, dict)
                or pending_backfill.get("mode") != mode
                or pending_backfill.get("batchId") != msg.get("batchId")
            ):
                print(
                    f"[E2E stale backfill ACK ignored {sid}] "
                    f"mode={mode} batch={msg.get('batchId')}",
                    file=sys.stderr,
                )
                return
            committed = msg.get("ok") is True and (
                (mode == "enable" and msg.get("e2e") is True)
                or (mode == "disable" and msg.get("e2e") is False)
            )
            if (
                mode == "enable"
                and isinstance(sid, str)
                and sid
                and msg.get("ok") is False
                and msg.get("e2e") is False
            ):
                # #818：server 已回滚 pending-enable → 按权威收敛丢钥。
                if self._e2e.abort_incomplete_enable(sid):
                    print(
                        f"· E2E enable aborted by server: {sid} — K_S dropped, plaintext resumed"
                    )
            if mode == "enable" and committed and isinstance(sid, str) and sid:
                try:
                    self._e2e.mark_enable_complete(sid)
                except Exception as exc:
                    print(f"[E2E mark_enable_complete {sid}] {exc!r}", file=sys.stderr)
            if mode == "disable" and isinstance(sid, str) and sid:
                try:
                    if committed:
                        pending = self._e2e.pending_disable(sid)
                        if pending is None and not self._e2e.is_e2e(sid):
                            # 該 disable 已在別處結算過（典型：ready 對賬按認證 receipt 先結
                            # 算，隨後遲到/重放的 result 才到）。K_S 早已刪除、本地無 pending，
                            # 這是**冪等成功**而非錯誤：絕不能 raise —— 一 raise 就被
                            # `_on_server_msg` 兜底吞掉，函數尾部的 pop/save 到不了，待確認
                            # 回灌永遠留在盤上、每次重連再把明文快照發一遍。
                            print(
                                f"· E2E disable result {sid}：本地已结算过，幂等接受并清理待确认回灌"
                            )
                            pending_all.pop(sid, None)
                            self._save_mirror_state(st, strict=True)
                            self._release_e2e_quiesce(sid, mode)
                            return
                        if pending is None or pending["receipt"] is None:
                            raise E2EControlError(
                                "disable result has no matching local release"
                            )
                        receipt = msg.get("disableReceipt")
                        if receipt != pending["receipt"]:
                            raise E2EControlError("disable result receipt mismatch")
                        verify_disable_receipt(
                            self._e2e.require_key(sid),
                            receipt,
                            expected_intent=pending["intent"],
                        )
                        self._e2e.complete_disable(sid, receipt)
                        print(f"· E2E 關閉提交 ACK：已刪除 {sid} 的 K_S")
                    else:
                        pending = self._e2e.pending_disable(sid)
                        if pending is not None and pending["receipt"] is None:
                            self._e2e.cancel_disable(sid)
                            print(
                                f"[E2E disable not committed {sid}] K_S retained",
                                file=sys.stderr,
                            )
                        elif pending is not None:
                            # plaintext + receipt 已经离机，不能信 server 的失败帧撤销本地
                            # release；保留 K_S/receipt，重连后重发或按 ready receipt 结算。
                            print(
                                f"[E2E disable result untrusted after release {sid}] "
                                "K_S/receipt retained",
                                file=sys.stderr,
                            )
                except Exception as exc:
                    # 持久状态无法安全结算时保持进程 fail noisy；不能吞掉后继续猜测明文态。
                    print(f"[E2E disable settle failed {sid}] {exc!r}", file=sys.stderr)
                    raise
            if committed:
                state_sid = pending_backfill.get("stateSid")
                cover = pending_backfill.get("cover")
                if isinstance(state_sid, str) and isinstance(cover, int):
                    wm = st["sessions"]
                    if cover > wm.get(state_sid, 0):
                        wm[state_sid] = cover
            if committed or msg.get("ok") is False:
                pending_all.pop(sid, None)
                self._save_mirror_state(st, strict=True)
                self._release_e2e_quiesce(sid, mode)
            return
        if t == "project_op":
            await self._project_op(msg)
            return
        if t != "tui":
            return

        frame = msg.get("frame") or {}
        method = frame.get("method")
        params = frame.get("params") or {}
        outer_sid = msg.get("sessionId")
        params_sid = params.get("session_id")
        if (
            isinstance(outer_sid, str)
            and isinstance(params_sid, str)
            and outer_sid != params_sid
        ):
            print(
                f"[dispatch rejected] Link B outer/params session mismatch: {outer_sid!r} != {params_sid!r}",
                file=sys.stderr,
            )
            return
        server_sid = params_sid or outer_sid
        if not isinstance(server_sid, str) or not server_sid:
            return
        # 屏障只攔「開新回合」的兩個方法(對齊 OpenClaw drive.ts 的 content 判定)。
        # ⚠️ 絕不能連 approval/clarification/secret.respond 一起攔:quiesce 是「先立屏障、再等
        # 在途回合收尾」,而回合可能正**停在審批卡等用戶點同意**——把 respond 丟掉,回合就永遠
        # 完不成 → 自旋必然跑滿超時 → 回合永久掛起、E2E 開關必失敗。這三個是「讓在途回合往前
        # 走完」的幀,恰恰是 quiesce 要等的東西。
        if server_sid in getattr(self, "_e2e_quiescing", {}) and method in (
            "prompt.submit",
            "command.invoke",
        ):
            print(
                f"[E2E quiesce rejected {method} {server_sid}] transition in progress",
                file=sys.stderr,
            )
            return
        try:
            alias_owner = self._protected_inbound_alias_owner(server_sid)
        except Exception as exc:
            print(
                f"[E2E inbound quarantined {server_sid}] {exc!r}",
                file=sys.stderr,
            )
            return
        if alias_owner is not None:
            print(
                f"[E2E local alias rejected {server_sid}] "
                f"canonical wire session is {alias_owner}",
                file=sys.stderr,
            )
            return
        assert self.gw is not None

        authenticated_control = False
        control_msg_id = None
        control_session_id = None
        control_error = None
        if method == "e2e.control":
            envelope = params.get("envelope")
            control_msg_id = envelope.get("msgId") if isinstance(envelope, dict) else None
            control_session_id = envelope.get("sessionId") if isinstance(envelope, dict) else None
            try:
                method, payload = self._e2e_control.verify_and_consume(envelope, server_sid)
                # 认证 payload 必须 shape 唯一；不能让不同语言/旧逻辑对额外字段作不同解释。
                keys = set(payload)
                if method == "command.invoke":
                    if keys not in ({"command"}, {"command", "argsEnc"}):
                        raise E2EControlError("invalid command.invoke payload")
                    # `/commands` catalog 目前来自不可信 server，设备无法证明 slug/展开语义；
                    # 即使信封本身有效也不能签执行。用户仍可把 `/foo` 当普通 E2E prompt 输入。
                    raise E2EControlError(
                        "command.invoke unsupported until command catalog is authenticated"
                    )
                elif method == "approval.respond":
                    required = {"blockId", "requestId", "requestDigest", "choice", "all"}
                    if keys != required:
                        raise E2EControlError("invalid approval.respond payload")
                    if any(not isinstance(payload.get(k), str) or not payload[k] for k in ("blockId", "requestId", "requestDigest", "choice")):
                        raise E2EControlError("invalid authenticated approval identity")
                    if not isinstance(payload.get("all"), bool):
                        raise E2EControlError("approval all must be explicit boolean")
                    if payload["choice"] not in ("yes", "no"):
                        raise E2EControlError("invalid authenticated approval choice")
                    if payload["all"]:
                        raise E2EControlError(
                            "persistent approval scope is unsupported for E2E"
                        )
                elif method == "clarify.respond":
                    required = {"blockId", "requestId", "requestDigest", "answerEnc"}
                    if keys != required or any(
                        not isinstance(payload.get(k), str) or not payload[k] for k in required
                    ):
                        raise E2EControlError("invalid clarify.respond payload")
                    # #273:解密 answerEnc 並與本地 pending 對賬；成功後 payload 帶明文 answer。
                    pending_map = self._e2e_interactives
                    pending = pending_map.get(payload["requestId"])
                    if (
                        not isinstance(pending, dict)
                        or pending.get("kind") != "clarify"
                        or pending.get("serverSid") != server_sid
                        or pending.get("requestDigest") != payload["requestDigest"]
                    ):
                        raise E2EControlError("no matching pending encrypted clarification")
                    frozen = pending.get("executionRequest")
                    if not isinstance(frozen, dict) or request_digest(
                        self._e2e.require_key(server_sid), frozen
                    ) != payload["requestDigest"]:
                        raise E2EControlError("clarification request digest mismatch")
                    try:
                        answer = self._e2e.decrypt_text(server_sid, payload["answerEnc"])
                    except Exception as exc:
                        raise E2EControlError("failed to decrypt clarify answer") from exc
                    payload = {
                        "blockId": payload["blockId"],
                        "requestId": payload["requestId"],
                        "requestDigest": payload["requestDigest"],
                        "answer": answer if isinstance(answer, str) else "",
                    }
                elif method == "secret.respond":
                    required = {"blockId", "requestId", "requestDigest", "secretEnc"}
                    if keys != required or any(
                        not isinstance(payload.get(k), str) or not payload[k] for k in required
                    ):
                        raise E2EControlError("invalid secret.respond payload")
                    pending_map = self._e2e_interactives
                    pending = pending_map.get(payload["requestId"])
                    if (
                        not isinstance(pending, dict)
                        or pending.get("kind") != "secret"
                        or pending.get("serverSid") != server_sid
                        or pending.get("requestDigest") != payload["requestDigest"]
                    ):
                        raise E2EControlError("no matching pending encrypted secret request")
                    frozen = pending.get("executionRequest")
                    if not isinstance(frozen, dict) or request_digest(
                        self._e2e.require_key(server_sid), frozen
                    ) != payload["requestDigest"]:
                        raise E2EControlError("secret request digest mismatch")
                    try:
                        value = self._e2e.decrypt_text(server_sid, payload["secretEnc"])
                    except Exception as exc:
                        raise E2EControlError("failed to decrypt secret value") from exc
                    payload = {
                        "blockId": payload["blockId"],
                        "requestId": payload["requestId"],
                        "requestDigest": payload["requestDigest"],
                        "value": value if isinstance(value, str) else "",
                    }
                elif method == "session.cwd.set":
                    if keys != {"cwd"} or payload["cwd"] is not None and not isinstance(payload["cwd"], str):
                        raise E2EControlError("invalid session.cwd.set payload")
                    # Hermes 的 `_cwds` 目前只是进程内状态，且 busy/重启无法证明设置已持久
                    # 生效。签封路径不能因此回成功 ACK；等有本地事务化 settings store 再开放。
                    raise E2EControlError("session.cwd.set is not safely supported by Hermes")
                elif method in ("session.permission.set", "session.model.set", "session.effort.set"):
                    # Hermes 没有这些 per-session 控制；不要 ACK 一个实际未应用的设置。
                    raise E2EControlError(f"{method} is not supported by Hermes")
                elif method == "session.interrupt":
                    if keys:
                        raise E2EControlError("invalid session.interrupt payload")
                    # 空 payload 没有绑定 connector 认证的当前 turn。server 可把用户为 A
                    # 签的 stop 延迟到 B 才投递；在引入本地 turn nonce 前必须 fail closed。
                    raise E2EControlError(
                        "session.interrupt unsupported until active turn is authenticated"
                    )
                elif method == "session.e2e.disable":
                    if keys:
                        raise E2EControlError("invalid session.e2e.disable payload")
                elif method == "task.stop":
                    # Hermes gateway 尚无后台任务 stop method；明确 NACK，不能把 no-op 当成功。
                    raise E2EControlError("task.stop is not supported by Hermes")
                else:
                    raise E2EControlError("unsupported authenticated control kind")
                params = {**payload, "session_id": server_sid}
                authenticated_control = True
            except Exception as exc:
                control_error = str(exc)
                print(f"[E2E control rejected {server_sid}] {exc}", file=sys.stderr)
                if isinstance(control_msg_id, str) and control_msg_id:
                    await self._send(
                        {
                            "t": "e2e_control_result",
                            "agentLinkId": self.agent_link_id,
                            "sessionId": control_session_id,
                            "hermesSessionId": server_sid,
                            "msgId": control_msg_id,
                            "ok": False,
                            # 不可信 server 不应从下游异常侧信道拿到已解密 args/本地路径。
                            # 细节已写本地 stderr；wire 只给稳定泛化码。
                            "error": "control_rejected",
                        }
                    )
                return

        sensitive_methods = {
            "command.invoke",
            "approval.respond",
            "clarify.respond",
            "secret.respond",
            # #702:本 PR 補上 sudo.respond 的轉發之後,它才**第一次**成為一條真的能打到
            # gateway 的路——此前沒有 dispatch 分支,漏不漏在這張表上都一樣。加了分支就必須
            # 同時進表,否則 E2E 會話下不可信 server 能把任意密碼(或空串取消)直送 sudo 提示,
            # 而同族的 clarify/secret 是 fail-closed 的——那個不對稱純屬疏漏,不是取捨。
            "sudo.respond",
            "session.create",
            "session.cwd.set",
            "session.permission.set",
            "session.model.set",
            "session.effort.set",
            "session.interrupt",
            "task.stop",
            "session.e2e.disable",
            # 这些虽然不是 agent prompt，却会写本机 transcript/镜像墓碑/归档状态；
            # E2E 下同样不能把 server 的裸帧当成用户意图。
            "session.delete",
            "session.rename",
            "session.archive",
            "session.retitle",
            # #473 rewind 是**真正的破壞性寫**(軟刪 state.db 行 + 丟運行時句柄),E2E 下更不能
            # 認 server 的裸帧。server 側 v1 也直接拒 E2E 會話,這裡是第二道。
            "session.rewind",
        }
        if self._e2e.is_protected(server_sid) and method in sensitive_methods and not authenticated_control:
            print(f"[E2E legacy control rejected {server_sid}] {method}", file=sys.stderr)
            return

        control_accepted = False
        try:
            if method == "prompt.submit":
                # #656 **就在這裡、任何 await 之前**標記「本端驅動中」。往下走的每一步都是異步的
                # (串行鏈排隊 → 附件/STT → _ensure_session 的 resume 往返),而 user 行一進 state.db
                # 鏡像就看得見它——標記晚一步,那一輪 2s 輪詢就把同一行再投一遍(見 self._driving)。
                self._mark_driving(server_sid)
                # #148:慢路徑(resume 往返/附件下載/STT)出讀循環——經 per-session 串行鏈派發,
                # 某會話的大附件/慢 STT 不再 head-of-line 阻塞其他會話。同會話仍按序。
                async def _do_prompt(params=params, server_sid=server_sid):
                    attachments = params.get("attachments") or []
                    if self._e2e.is_protected(server_sid) and attachments:
                        # v1 E2E 设备端不支持附件；该数组仍是 server 可改写的明文。绝不能
                        # 在密文 prompt 旁边接受它，否则 server 可触发下载/SSRF/STT/本地
                        # attach，并把任意路径注入 agent。
                        print(
                            f"[E2E prompt rejected {server_sid}] unauthenticated attachments",
                            file=sys.stderr,
                        )
                        return
                    # #251(#1):文本裝配(標題/解密/STT)提前到 _ensure_session **之前**——這樣 gateway
                    # 死於建會話時,能拿已裝配好的 final_text 走重投(而非 _ensure_session 誤建空會話)。
                    parts = []
                    base = (params.get("text") or "").strip()
                    # #94：Macchiato 發起的會話首次發話 → 立即用首條 user 文本自動生成標題(越早越好)。
                    # E2E 跳過(明文);已標題過跳過;_titled 防會話內重複。
                    if base and server_sid not in self._titled and not self._e2e.is_protected(server_sid):
                        self._titled.add(server_sid)
                        asyncio.create_task(self._auto_title(server_sid, base))
                    if base and self._e2e.is_protected(server_sid):
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
                    # #855:落盤 + file/image.attach 之後,把路徑註記拼進本回合 prompt。
                    # file.attach 不注入輸入;不寫註記 = agent 只看得到文字、要自己搜文件名。
                    notes, failed = await self._attach_refs(server_sid, real, non_audio_refs)
                    final_text = self._merge_attach_notes(final_text, notes)
                    if not final_text:
                        # 純附件且全部 attach 失敗 → 不打擾 agent;用戶已收 review.summary。
                        if failed or non_audio_refs:
                            print(
                                f"· 附件全部失敗,跳過提交 agent（failed={len(failed)}）",
                                file=sys.stderr,
                            )
                            return
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
                        print(
                            f"· #199 dispatch 未展開 name={name},原文提交兜底",
                            file=sys.stderr,
                        )
                    await self._submit_final(server_sid, real, text, [])
                    # #381:绝不写 args / 展开正文
                    print(
                        format_command_invoke_log(
                            name=name,
                            args_len=len(arg),
                            sid=server_sid,
                            expanded_len=len(text),
                        )
                    )
                    log_content("command.invoke", text)
                invoke_task = self._dispatch_session(
                    server_sid, _do_invoke, propagate=authenticated_control
                )
                if authenticated_control:
                    await invoke_task
                control_accepted = authenticated_control
            elif method == "approval.respond":
                # #251(#4):此前在讀循環內聯調 _ensure_session,與同會話 _do_prompt 的
                # _ensure_session 併發 → 雙 create、_fwd 覆寫、洩漏 gateway 會話。掛進 per-session
                # 串行鏈,和 prompt/invoke 排同一隊(審批發生在回合中、鏈通常已空,不增延遲)。
                async def _do_approval(params=params, server_sid=server_sid):
                    if authenticated_control:
                        pending = self._e2e_approvals.get(server_sid)
                        head = pending[0] if pending else None
                        frozen_digest = (
                            request_digest(
                                self._e2e.require_key(server_sid),
                                head.get("executionRequest"),
                            )
                            if head is not None and isinstance(head.get("executionRequest"), dict)
                            else None
                        )
                        if (
                            head is None
                            or frozen_digest != head.get("requestDigest")
                            or params.get("requestId") != head.get("requestId")
                            or params.get("requestDigest") != head.get("requestDigest")
                        ):
                            raise E2EControlError("approval request id/digest does not match FIFO head")
                        # Hermes gateway 的 approval.respond 沒有 request id / idempotency key。
                        # RPC 若已在 gateway 生效、但回包前斷線，保留本地 head 會讓同一張已簽卡
                        # 以 fresh seq 重試並誤批 FIFO 的下一張。故在任何下游副作用前不可逆
                        # 消費本地 capability；不確定結果犧牲可用性，也不能重新開放授權。
                        pending.popleft()
                        if not pending:
                            self._e2e_approvals.pop(server_sid, None)
                    real = await self._ensure_session(server_sid)
                    self._plain_approvals.discard(server_sid)  # #669 心跳:已答覆 → 不再掛起
                    await self.gw.request(
                        "approval.respond",
                        {"session_id": real, "choice": params.get("choice", "deny"), "all": params.get("all", False)},
                    )
                # requestId/digest 在排队前同步核对一次，避免先 ACK 后才在异步链发现错卡。
                if authenticated_control:
                    pending = self._e2e_approvals.get(server_sid)
                    head = pending[0] if pending else None
                    frozen_digest = (
                        request_digest(
                            self._e2e.require_key(server_sid),
                            head.get("executionRequest"),
                        )
                        if head is not None and isinstance(head.get("executionRequest"), dict)
                        else None
                    )
                    if (
                        head is None
                        or frozen_digest != head.get("requestDigest")
                        or params.get("requestId") != head.get("requestId")
                        or params.get("requestDigest") != head.get("requestDigest")
                    ):
                        raise E2EControlError("approval request id/digest does not match FIFO head")
                approval_task = self._dispatch_session(
                    server_sid, _do_approval, propagate=authenticated_control
                )
                if authenticated_control:
                    await approval_task
                control_accepted = authenticated_control
            elif method == "clarify.respond":
                # #702/#109:非 E2E 把用戶所選 label 轉到 tui_gateway。
                # #273 E2E：verify 階段已解出 answer，這裡 pop 待決並投遞。
                async def _do_clarify(params=params, server_sid=server_sid):
                    req_id = str(params.get("requestId") or params.get("request_id") or "")
                    answer = params.get("answer")
                    if not isinstance(answer, str):
                        answer = ""
                    if authenticated_control:
                        pending_map = self._e2e_interactives
                        pending = pending_map.pop(req_id, None)
                        if not isinstance(pending, dict) or pending.get("kind") != "clarify":
                            raise E2EControlError("no matching pending encrypted clarification")
                    if not req_id:
                        if authenticated_control:
                            raise E2EControlError("clarify.respond missing request_id")
                        print(
                            f"[clarify.respond dropped {server_sid}] missing request_id",
                            file=sys.stderr,
                        )
                        return
                    assert self.gw is not None
                    await self.gw.request(
                        "clarify.respond",
                        {"request_id": req_id, "answer": answer},
                    )
                clarify_task = self._dispatch_session(
                    server_sid, _do_clarify, propagate=authenticated_control
                )
                if authenticated_control:
                    await clarify_task
                control_accepted = authenticated_control
            elif method == "secret.respond":
                # #396/#702 非 E2E：value 瞬態回 gateway；#273 E2E：verify 已解出 value。
                async def _do_secret(params=params, server_sid=server_sid):
                    req_id = str(params.get("requestId") or params.get("request_id") or "")
                    value = params.get("value")
                    if not isinstance(value, str):
                        value = ""
                    if authenticated_control:
                        pending_map = self._e2e_interactives
                        pending = pending_map.pop(req_id, None)
                        if not isinstance(pending, dict) or pending.get("kind") != "secret":
                            raise E2EControlError("no matching pending encrypted secret request")
                    if not req_id:
                        if authenticated_control:
                            raise E2EControlError("secret.respond missing request_id")
                        print(
                            f"[secret.respond dropped {server_sid}] missing request_id",
                            file=sys.stderr,
                        )
                        return
                    assert self.gw is not None
                    await self.gw.request(
                        "secret.respond",
                        {"request_id": req_id, "value": value},
                    )
                secret_task = self._dispatch_session(
                    server_sid, _do_secret, propagate=authenticated_control
                )
                if authenticated_control:
                    await secret_task
                control_accepted = authenticated_control
            elif method == "sudo.respond":
                # #396:sudo 密碼瞬態回 gateway(空串 = 取消)。E2E 下仍抑制(無雙向加密)。
                async def _do_sudo(params=params, server_sid=server_sid):
                    req_id = str(params.get("requestId") or params.get("request_id") or "")
                    password = params.get("password")
                    if not isinstance(password, str):
                        password = ""
                    if not req_id:
                        print(
                            f"[sudo.respond dropped {server_sid}] missing request_id",
                            file=sys.stderr,
                        )
                        return
                    assert self.gw is not None
                    await self.gw.request(
                        "sudo.respond",
                        {"request_id": req_id, "password": password},
                    )
                self._dispatch_session(server_sid, _do_sudo)
            elif method == "session.interrupt":
                # #5:重投等待期(#4)收到中斷 → 取消重投——用戶已叫停的 prompt 不許復活雙發。
                rt = self._retry_tasks.pop(server_sid, None)
                retry_active = rt is not None and not rt.done()
                chain = self._session_chains.get(server_sid)
                chain_active = chain is not None and not chain.done()
                live_active = server_sid in self._live_inflight
                if authenticated_control and not (retry_active or chain_active or live_active):
                    raise E2EControlError("no active turn to interrupt")
                if retry_active:
                    rt.cancel()
                    print(f"· 用戶中斷 → 取消待重投 prompt({server_sid})")
                real = self._fwd.get(server_sid)
                if real and (not authenticated_control or chain_active or live_active):
                    await self.gw.interrupt(real)
                elif not authenticated_control or chain_active or live_active:
                    # 回合真正開始前到達的中斷：會話映射尚未建立 → 別丟，記為 pending，
                    # 等 prompt 建立映射、回合起步後一起取消（見 prompt.submit 末尾）。
                    self._pending_interrupt.add(server_sid)
                    print(f"· interrupt 早到（{server_sid} 未映射）→ pending", file=sys.stderr)
                control_accepted = authenticated_control
            elif method == "session.e2e.disable":
                if not authenticated_control:
                    raise E2EControlError("E2E disable requires authenticated device intent")
                # 先把 intent 与 K_S 同一快照持久化，随后才 ACK/启动明文回灌。断线重启
                # 时 server 的 raw resume 也只能在这个 marker 存在时续跑。
                self._e2e.begin_disable(server_sid, envelope)
                asyncio.create_task(self._e2e_backfill_history(server_sid, mode="disable"))
                control_accepted = True
            elif method == "session.create":
                # #227/#423 cwd:草稿期傳來的工作目錄。
                #  - 空 = 清回無 per-session 覆寫(默認不動,不注入專用工作區);
                #  - 顯式下發 → realpath + 存在 + 是目錄 + 可選 allowlist,fail closed:
                #    不過則不寫 `_cwds`、不傳 gateway,回 review.summary(與 TS 兩家同文案);
                #  - 合法路徑:未建 → 存起來 create 帶上;已建 → session.cwd.set。
                #    回合進行中改 cwd 仍照常記下(busy=4009 既有邏輯吞),**不** mid-turn reject。
                cwd_raw = str(params.get("cwd") or "").strip()
                cwd = ""
                cwd_rejected = False
                if cwd_raw:
                    cres = resolve_cwd(cwd_raw)
                    if not cres.ok:
                        await self._emit_cwd_reject(
                            server_sid, cres.reason or f"工作目錄無效:{cwd_raw}"
                        )
                        cwd_rejected = True
                    else:
                        cwd = cres.cwd
                        # cwd 存儲同步(_do_prompt 的 _ensure_session 讀 self._cwds)——先於建會話派發。
                        self._cwds[server_sid] = cwd
                else:
                    self._cwds.pop(server_sid, None)

                # #251(#4):建會話/改 cwd 的 gateway 調用掛進 per-session 串行鏈,不再在讀循環內聯
                # 與 _do_prompt 的 _ensure_session 併發雙 create。非法 cwd 已拒 → 不派發 gateway。
                if not cwd_rejected:
                    async def _do_create(server_sid=server_sid, cwd=cwd):
                        real = self._fwd.get(server_sid)
                        if real is None:
                            await self._ensure_session(server_sid)
                        elif cwd:
                            try:
                                await self.gw.request(
                                    "session.cwd.set", {"session_id": real, "cwd": cwd}
                                )
                                print(f"· #227 session.cwd.set {real} → {cwd}")
                            except GatewayError as exc:
                                if exc.code != 4009:  # 4009=busy(已鎖),其餘上拋
                                    raise
                    create_task = self._dispatch_session(
                        server_sid, _do_create, propagate=authenticated_control
                    )
                    if authenticated_control:
                        await create_task
                control_accepted = authenticated_control
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
            elif method == "session.rewind":
                # #473 回退到某條用戶消息之前。server 在等這條 ACK——**它只有收到 ok 才刪自己的
                # 行**,所以無論成敗、無論拋不拋,都必須回一幀,否則它 30s 超時後判失敗、用戶白等。
                request_id = str(params.get("request_id") or "")
                target_src_id = str(params.get("target_src_id") or "")
                ok, rewound, err = False, 0, "failed"
                try:
                    ok, rewound, err = await self._rewind_hermes(server_sid, target_src_id)
                except Exception as exc:
                    print(f"[session.rewind {server_sid} failed] {exc!r}", file=sys.stderr)
                try:
                    await self._send(
                        {
                            "t": "rewind_result",
                            "agentLinkId": self.agent_link_id,
                            "hermesSessionId": server_sid,
                            "requestId": request_id,
                            "ok": ok,
                            **({"rewound": rewound} if ok else {"error": err or "failed"}),
                        }
                    )
                except Exception as exc:
                    print(f"[rewind result 發送失敗 {server_sid}] {exc!r}", file=sys.stderr)
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
            control_error = (
                "control_rejected"
                if isinstance(exc, E2EControlError)
                else "side_effect_failed"
            )

        if authenticated_control and isinstance(control_msg_id, str) and control_msg_id:
            await self._send(
                {
                    "t": "e2e_control_result",
                    "agentLinkId": self.agent_link_id,
                    "sessionId": control_session_id,
                    "hermesSessionId": server_sid,
                    "msgId": control_msg_id,
                    "ok": bool(control_accepted and control_error is None),
                    **({"error": control_error} if control_error else {}),
                }
            )


async def _main() -> int:
    server_url = os.environ.get("MACCHIATO_SERVER_URL")
    token = os.environ.get("MACCHIATO_CONNECTOR_TOKEN")
    agent_link_id = os.environ.get("MACCHIATO_AGENT_LINK_ID")

    # 回落到 pair.py 存下的憑證（~/.macchiato/connector.json）。
    cred_path = _cred_path()
    cred: dict = {}
    if os.path.exists(cred_path):
        try:
            with open(cred_path) as f:
                cred = json.load(f)
        except Exception:
            cred = {}
    if not token or not agent_link_id:
        token = token or cred.get("connector_token")
        agent_link_id = agent_link_id or cred.get("agent_link_id")
        server_url = server_url or cred.get("server_url")

    server_url = server_url or "ws://localhost:8080/connector"
    if not token or not agent_link_id:
        # #387 解綁標記在場 → 這不是配置事故而是用戶在 app 裡解綁了:退 78,
        # 新版 unit(RestartPreventExitStatus=78)不再拉起。
        if os.path.exists(cred_path + ".revoked"):
            print(
                "Unpaired from the Macchiato app — credentials retired. "
                "Re-run the install command to pair again.",
                file=sys.stderr,
            )
            return 78
        print(
            "FAIL: 未配對。先跑 pair.py，或設 MACCHIATO_CONNECTOR_TOKEN/MACCHIATO_AGENT_LINK_ID。",
            file=sys.stderr,
        )
        return 2
    c = Connector(server_url, token, agent_link_id)
    # #731 設備授權：從配對憑證注入 secret；舊檔無 secret → wrap 降級。
    def _persist_authorized(authorized: dict) -> None:
        try:
            latest = dict(cred)
            if os.path.exists(cred_path):
                with open(cred_path) as f:
                    latest = json.load(f)
            latest["authorized_devices"] = authorized
            tmp = cred_path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                os.fchmod(f.fileno(), 0o600)
                json.dump(latest, f, indent=2)
            os.replace(tmp, cred_path)
        except Exception as exc:
            print(f"[E2E device-auth] 寫回 authorized_devices 失敗: {exc}", file=sys.stderr)

    c.configure_device_auth(
        cred.get("device_auth_secret"),
        agent_link_id,
        authorized_devices=cred.get("authorized_devices") if isinstance(cred.get("authorized_devices"), dict) else None,
        persist_authorized=_persist_authorized if cred.get("device_auth_secret") else None,
    )
    try:
        await c.run()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
