#!/usr/bin/env python3
"""
Macchiato connector pairing — bind THIS machine to your Macchiato account (design.md §5).

Flow:
  1. open WSS to the App Server, send pair_request → server returns a one-time code
  2. you log into the web app and enter the code (it claims this connector)
  3. server pushes a long-lived connector_token back over THIS socket (plaintext once)
     → saved to ~/.macchiato/connector.json

The socket must stay open until you claim, so this script waits (≈ the 8-min code TTL).

Run with the Hermes venv python (has `websockets`):
  MACCHIATO_SERVER_URL=wss://api.macchiato.chat/connector \
  ~/.local/share/pipx/venvs/hermes-agent/bin/python services/hermes-connector/pair.py
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import sys

import websockets

SERVER_URL = os.environ.get("MACCHIATO_SERVER_URL", "wss://api.macchiato.chat/connector")
WEB_URL = os.environ.get("MACCHIATO_WEB_URL", "https://macchiato.chat")
# #309 多 profile 實例:每實例文件根(與 connector.py 的 STATE_DIR 同義,默認零遷移)。
STATE_DIR = os.path.expanduser(os.environ.get("MACCHIATO_STATE_DIR", "").strip() or "~/.macchiato")
CRED_PATH = os.path.expanduser(os.environ.get("MACCHIATO_CRED") or os.path.join(STATE_DIR, "connector.json"))
# #254:配對碼此前寫 /tmp 世界可讀——共享機他人可讀碼、搶先 claim 把 agent 綁到攻擊者帳號。
# 改寫 ~/.macchiato/ 0600(下方 _write_private)。可 env 覆蓋但默認私有。
CODE_FILE = os.path.expanduser(os.environ.get("MACCHIATO_CODE_FILE") or os.path.join(STATE_DIR, "pair-code.txt"))
PROTO = 4  # 對齊 server 的 LINK_B_PROTO（packages/protocol）；不符會被拒 "proto mismatch"
WAIT_S = 30 * 60  # overall pairing window (we refresh the code well within the server TTL)
REFRESH_S = 6 * 60 + 30  # re-request a fresh code before the server's 8-min code TTL


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


def _save_cred(msg: dict, label: str) -> None:
    cred = {
        "server_url": SERVER_URL,
        "connector_token": msg["connectorToken"],
        "agent_link_id": msg["agentLinkId"],
        "label": label,
    }
    _write_private(CRED_PATH, json.dumps(cred, indent=2))


# 多連接器/多 profile 順序配對時分不清哪個碼是誰的——banner 自報家門。
# profile 名由 install.sh 經 MACCHIATO_HERMES_PROFILE 傳入(#309;缺省=默認 Hermes)。
_PAIR_PROFILE = os.environ.get("MACCHIATO_HERMES_PROFILE", "").strip()
_PAIR_WHO = f"Hermes profile '{_PAIR_PROFILE}'" if _PAIR_PROFILE else "Hermes"


def _show_code(code: str, fresh: bool) -> None:
    try:
        _write_private(CODE_FILE, code)  # #254 0600 私有(此前 /tmp 世界可讀 → 他人可搶 claim)
    except Exception:
        pass
    print("\n" + "=" * 54)
    print(f"  Pairing code for {_PAIR_WHO}" + (" (refreshed)" if fresh else "") + ":")
    print(f"        >>>  {code}  <<<")
    print(f"  Sign in at {WEB_URL} → \"Pair connector\" → enter this code.")
    print("=" * 54 + "\nWaiting for you to claim it…", flush=True)


async def _attempt(label: str, fresh: bool) -> str:
    """一次配對嘗試（連接保活 + 定期換新碼防 server 8-min TTL 過期）。
    返回 'paired' / 'auth_error'；連接斷開則拋 ConnectionClosed 讓外層重連。"""
    async with websockets.connect(
        SERVER_URL, open_timeout=20, ping_interval=15, ping_timeout=None, close_timeout=10
    ) as ws:

        async def refresher() -> None:
            while True:
                await asyncio.sleep(REFRESH_S)
                await ws.send(json.dumps({"t": "pair_request", "proto": PROTO, "label": label, "kind": "hermes"}))

        await ws.send(json.dumps({"t": "pair_request", "proto": PROTO, "label": label, "kind": "hermes"}))
        seen_first = False
        ref = asyncio.create_task(refresher())
        try:
            async for raw in ws:
                msg = json.loads(raw)
                t = msg.get("t")
                if t == "pair_pending":
                    _show_code(msg.get("code", ""), fresh or seen_first)
                    seen_first = True
                elif t == "auth_error":
                    print(f"FAIL: {msg.get('reason')}", file=sys.stderr)
                    return "auth_error"
                elif t == "paired":
                    _save_cred(msg, label)
                    try:
                        os.remove(CODE_FILE)
                    except OSError:
                        pass
                    print(f"\n✓ Paired! agent_link={msg['agentLinkId']}")
                    print(f"  Credentials saved to {CRED_PATH} (connector_token shown in plaintext only this once).")
                    return "paired"
        finally:
            ref.cancel()
        raise websockets.exceptions.ConnectionClosed(None, None)


async def main() -> int:
    default_label = (
        f"Hermes:{_PAIR_PROFILE} ({socket.gethostname()})" if _PAIR_PROFILE else f"Hermes ({socket.gethostname()})"
    )
    label = os.environ.get("MACCHIATO_LABEL") or default_label
    loop = asyncio.get_running_loop()
    deadline = loop.time() + WAIT_S
    fresh = False
    while loop.time() < deadline:
        print(f"· connecting to {SERVER_URL} …", flush=True)
        try:
            outcome = await _attempt(label, fresh)
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
