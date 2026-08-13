#!/usr/bin/env python3
"""
Macchiato connector pairing — bind THIS machine to your Macchiato account (design.md §5).

Flow:
  1. open WSS to the App Server, send pair_request → server returns a one-time code
  2. you log into the web app and enter the code (it claims this connector)
  3. server pushes a long-lived connector_token back over THIS socket (plaintext once)
     → saved to ~/.macchiato/connector.json

The socket must stay open until you claim. #832：server 碼 TTL 20 分鐘；本腳本按
expiresAt 在過期前自動 pair_request 換新並重打終端 QR（純庫，不依賴 qrencode）。

Run with the Hermes venv python (has `websockets`):
  MACCHIATO_SERVER_URL=wss://api.macchiato.chat/connector \
  ~/.local/share/pipx/venvs/hermes-agent/bin/python services/hermes-connector/pair.py
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import sys
import time

import websockets

from qr_terminal import print_qr_terminal

SERVER_URL = os.environ.get("MACCHIATO_SERVER_URL", "wss://api.macchiato.chat/connector")
WEB_URL = os.environ.get("MACCHIATO_WEB_URL", "https://macchiato.chat")
# #309 多 profile 實例:每實例文件根(與 connector.py 的 STATE_DIR 同義,默認零遷移)。
STATE_DIR = os.path.expanduser(os.environ.get("MACCHIATO_STATE_DIR", "").strip() or "~/.macchiato")
CRED_PATH = os.path.expanduser(os.environ.get("MACCHIATO_CRED") or os.path.join(STATE_DIR, "connector.json"))
# #254:配對碼此前寫 /tmp 世界可讀——共享機他人可讀碼、搶先 claim 把 agent 綁到攻擊者帳號。
# 改寫 ~/.macchiato/ 0600(下方 _write_private)。可 env 覆蓋但默認私有。
CODE_FILE = os.path.expanduser(os.environ.get("MACCHIATO_CODE_FILE") or os.path.join(STATE_DIR, "pair-code.txt"))
PROTO = 5  # 對齊 server 的 LINK_B_PROTO（packages/protocol）；不符會被拒 "proto mismatch"
WAIT_S = 30 * 60  # overall pairing window (we refresh the code well within the server TTL)
# #832 沒拿到 expiresAt 時的兜底（server TTL 20min，留 90s 餘量）
_FALLBACK_REFRESH_S = 18 * 60 + 30
_REFRESH_BEFORE_EXPIRY_S = 90
_MIN_REFRESH_S = 30


def _write_private(path: str, content: str) -> None:
    """#254:0600 原子寫——O_CREAT 帶 mode(不經「先寫 0644 後 chmod」窗口)+ fchmod 抵 umask + rename。
    含 connector_token / 配對碼的文件從落盤第一刻就只有本人可讀。"""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:  # fdopen 接管 fd,with 退出即關(異常也關)
        os.fchmod(f.fileno(), 0o600)  # umask 可能削弱 O_CREAT 的 mode → 顯式收緊
        f.write(content)
    os.replace(tmp, path)


# #731 生成側**不用數字**（鏡像 connector-core/src/e2e/device-auth.ts）：
# 存量 iOS 的配對碼輸入框有 `filter(\.isNumber)`，用戶把完整 token 粘進去時會把 secret 裡的
# 數字拼進配對碼 → 配對失敗。secret 本身不進配對碼（只在 QR 與單獨一行），這是第二道保險。
# 解析側照舊接受含數字的 secret（早期配對可能已落盤過），只約束生成。
_B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_DIGIT_FREE_B64URL = "".join(c for c in _B64URL_ALPHABET if not c.isdigit())
# 43 字符的 base64url 恰好編碼 32 字節，末位只用到高 4 bit——低 2 bit 必須為 0 才是**規範**
# 編碼（否則嚴格解碼跨端分歧）。故末位取「6-bit 值 ≡ 0 (mod 4)」且不含數字的字符。
_DIGIT_FREE_B64URL_TAIL = "".join(
    c for c in _DIGIT_FREE_B64URL if _B64URL_ALPHABET.index(c) % 4 == 0
)
_SECRET_CHARS = -(-32 * 8 // 6)  # 32 字節 → 43 字符


def _new_device_auth_secret() -> str:
    """#731：32 字節高熵 secret（base64url、不含數字），僅經 QR/終端行給設備。"""
    body = "".join(secrets.choice(_DIGIT_FREE_B64URL) for _ in range(_SECRET_CHARS - 1))
    return body + secrets.choice(_DIGIT_FREE_B64URL_TAIL)


def _format_pairing_token(code: str, secret: str) -> str:
    return f"{code}.{secret}"


def _save_cred(msg: dict, label: str, device_auth_secret: str | None) -> None:
    cred = {
        "server_url": SERVER_URL,
        "connector_token": msg["connectorToken"],
        "agent_link_id": msg["agentLinkId"],
        "label": label,
    }
    # #731 設備授權 secret（舊配對檔無此字段 → wrap 降級）。
    # ⚠️ 只有**真的展示過**的 secret 才存：#388 一碼多綁的兄弟 agent 是各自的進程、
    # 各自生成 secret 但從不打印，存了就是「有 secret 卻沒人持有」→ wrap 全跳過、
    # E2E 永久不可用且零提示。鏡像 packages/connector-core/src/linkb/pairing.ts。
    if device_auth_secret:
        cred["device_auth_secret"] = device_auth_secret
    _write_private(CRED_PATH, json.dumps(cred, indent=2))


# 多連接器/多 profile 順序配對時分不清哪個碼是誰的——banner 自報家門。
# profile 名由 install.sh 經 MACCHIATO_HERMES_PROFILE 傳入(#309;缺省=默認 Hermes)。
_PAIR_PROFILE = os.environ.get("MACCHIATO_HERMES_PROFILE", "").strip()
_PAIR_WHO = f"Hermes profile '{_PAIR_PROFILE}'" if _PAIR_PROFILE else "Hermes"
_PAIR_GROUP = os.environ.get("MACCHIATO_PAIR_GROUP", "").strip() or _PAIR_WHO
# #388 一碼多綁:安裝器生成的批次 id(僅 WSS 內傳輸);同批第一個被 claim 後本連接器免碼自動綁定
_PAIR_BATCH = os.environ.get("MACCHIATO_PAIR_BATCH", "").strip()


def _refresh_delay_s(expires_at_iso: str | None, now: float | None = None) -> float:
    """#832 按 server expiresAt 算下次 pair_request 延遲（過期前 90s 換新）。

    ⚠️ 上限鉗到 _FALLBACK_REFRESH_S：expires_at 是 server 的**絕對**時間，這裡拿它跟本機
    時鐘相減。剛裝好的機器 / VM 時鐘慢一小時是常事——不鉗的話會算出「78 分鐘後再換」，
    可碼 20 分鐘就死了，中間用戶掃到的全是死碼。
    """
    now = time.time() if now is None else now
    if expires_at_iso:
        try:
            # ISO-8601 UTC from server, e.g. 2026-08-10T12:00:00.000Z
            exp = expires_at_iso.replace("Z", "+00:00")
            from datetime import datetime

            exp_ts = datetime.fromisoformat(exp).timestamp()
            delay = exp_ts - now - _REFRESH_BEFORE_EXPIRY_S
            if delay >= _MIN_REFRESH_S:
                return float(min(delay, _FALLBACK_REFRESH_S))
            return float(_MIN_REFRESH_S)
        except Exception:
            pass
    return float(_FALLBACK_REFRESH_S)


def _show_code(code: str, fresh: bool, device_auth_secret: str, expires_at_iso: str | None = None) -> None:
    token = _format_pairing_token(code, device_auth_secret)
    try:
        # #254 0600 私有；#731 寫完整 token（含 secret），便於本機腳本讀取。
        _write_private(CODE_FILE, token)
    except Exception:
        pass
    print("\n" + "=" * 54)
    print(f"  Pairing code for {_PAIR_GROUP}" + (" (refreshed)" if fresh else "") + ":")
    # ⚠️ 回歸契約:scripts/regression/*、scripts/localchain/run.mjs 與 run-folders-e2e.mjs 斷言
    # 「>>> <純數字碼> <<<」(folders-e2e 還靠上行「code」字樣定位)——這一行**只准放數字**。
    print(f"        >>>  {code}  <<<")
    if expires_at_iso:
        try:
            exp = expires_at_iso.replace("Z", "+00:00")
            from datetime import datetime

            # 同 _refresh_delay_s：本機時鐘可能偏，封頂到「最晚也會自動換碼」的那個時刻，
            # 別報出「Expires in ~80 min」這種讓人放心離開一小時的假數字。
            remain_s = min(
                datetime.fromisoformat(exp).timestamp() - time.time(),
                _FALLBACK_REFRESH_S + _REFRESH_BEFORE_EXPIRY_S,
            )
            remain_min = max(1, round(remain_s / 60))
            print(f"  Expires in ~{remain_min} min (a new code will appear automatically before then).")
        except Exception:
            pass
    print(f"  Sign in at {WEB_URL} → \"Pair connector\" → enter this code.")
    # #731 secret 不進配對碼(見 connector-core/linkb/pairing.ts 的說明);想開 E2E 才需要這行。
    print("\n  Optional — end-to-end encryption device key (iOS only; scanning the QR covers this):")
    print(f"        {device_auth_secret}")
    if _PAIR_BATCH and os.environ.get("MACCHIATO_PAIR_BATCH_MANY"):
        print("  Other agents from this install will pair automatically with this code.")
    # #832 終端 QR：純庫渲染（不依賴 qrencode）。#731 帶完整 token（含 e2eAuth）。
    print_qr_terminal(token)
    print("=" * 54 + "\nWaiting for you to claim it…", flush=True)


async def _attempt(label: str, fresh: bool, device_auth_secret: str) -> str:
    """一次配對嘗試（連接保活 + 按 expiresAt 換新碼）。
    返回 'paired' / 'auth_error'；連接斷開則拋 ConnectionClosed 讓外層重連。"""
    async with websockets.connect(
        SERVER_URL, open_timeout=20, ping_interval=15, ping_timeout=None, close_timeout=10
    ) as ws:

        async def send_pair() -> None:
            await ws.send(json.dumps({
                "t": "pair_request", "proto": PROTO, "label": label, "kind": "hermes",
                **({"batch": _PAIR_BATCH} if _PAIR_BATCH else {}),
            }))

        refresh_task: asyncio.Task | None = None

        async def schedule_refresh(expires_at_iso: str | None) -> None:
            nonlocal refresh_task
            if refresh_task is not None:
                refresh_task.cancel()
                try:
                    await refresh_task
                except (asyncio.CancelledError, Exception):
                    pass

            async def _fire() -> None:
                delay = _refresh_delay_s(expires_at_iso)
                await asyncio.sleep(delay)
                await send_pair()

            refresh_task = asyncio.create_task(_fire())

        await send_pair()
        seen_first = False
        try:
            async for raw in ws:
                msg = json.loads(raw)
                t = msg.get("t")
                if t == "pair_pending":
                    exp = msg.get("expiresAt")
                    _show_code(msg.get("code", ""), fresh or seen_first, device_auth_secret, exp)
                    seen_first = True
                    await schedule_refresh(exp if isinstance(exp, str) else None)
                elif t == "auth_error":
                    print(f"FAIL: {msg.get('reason')}", file=sys.stderr)
                    return "auth_error"
                elif t == "paired":
                    if not seen_first:
                        # #388:沒展示過碼就 paired = 同批安裝免碼自動綁定
                        print("\n✓ Paired automatically — claimed with the same code as the first agent in this install.")
                        print("  (E2E device auth: this agent has no pairing secret — pair it on its own to enable it.)")
                    # #731:只存展示過的 secret(見 _save_cred)
                    _save_cred(msg, label, device_auth_secret if seen_first else None)
                    try:
                        os.remove(CODE_FILE)
                    except OSError:
                        pass
                    print(f"\n✓ Paired! agent_link={msg['agentLinkId']}")
                    print(f"  Credentials saved to {CRED_PATH} (connector_token shown in plaintext only this once).")
                    return "paired"
        finally:
            if refresh_task is not None:
                refresh_task.cancel()
                try:
                    await refresh_task
                except (asyncio.CancelledError, Exception):
                    pass
        raise websockets.exceptions.ConnectionClosed(None, None)


async def main() -> int:
    default_label = (
        f"Hermes:{_PAIR_PROFILE} ({socket.gethostname()})" if _PAIR_PROFILE else f"Hermes ({socket.gethostname()})"
    )
    label = os.environ.get("MACCHIATO_LABEL") or default_label
    # #731：整個配對窗口共用一把 secret（換碼不換 secret）。
    device_auth_secret = _new_device_auth_secret()
    loop = asyncio.get_running_loop()
    deadline = loop.time() + WAIT_S
    fresh = False
    while loop.time() < deadline:
        print(f"· connecting to {SERVER_URL} …", flush=True)
        try:
            outcome = await _attempt(label, fresh, device_auth_secret)
            if outcome == "paired":
                return 0
            if outcome == "auth_error":
                return 1
        except (websockets.exceptions.ConnectionClosed, OSError, asyncio.TimeoutError) as exc:
            print(f"· Connection dropped ({type(exc).__name__}), reconnecting with a fresh code…", file=sys.stderr, flush=True)
            fresh = True
            continue
    print("\nFAIL: pairing window expired unclaimed — re-run to try again.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
