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
CRED_PATH = os.path.expanduser(os.environ.get("MACCHIATO_CRED", "~/.macchiato/connector.json"))
CODE_FILE = os.environ.get("MACCHIATO_CODE_FILE", "/tmp/macchiato-pair-code.txt")
PROTO = 3  # 對齊 server 的 LINK_B_PROTO（packages/protocol）；不符會被拒 "proto mismatch"
WAIT_S = 30 * 60  # overall pairing window (we refresh the code well within the server TTL)
REFRESH_S = 6 * 60 + 30  # re-request a fresh code before the server's 8-min code TTL


def _save_cred(msg: dict, label: str) -> None:
    cred = {
        "server_url": SERVER_URL,
        "connector_token": msg["connectorToken"],
        "agent_link_id": msg["agentLinkId"],
        "label": label,
    }
    os.makedirs(os.path.dirname(CRED_PATH), exist_ok=True)
    with open(CRED_PATH, "w") as f:
        json.dump(cred, f, indent=2)
    os.chmod(CRED_PATH, 0o600)


def _show_code(code: str, fresh: bool) -> None:
    try:
        with open(CODE_FILE, "w") as f:
            f.write(code)
    except Exception:
        pass
    print("\n" + "=" * 54)
    print("  Pairing code" + (" (refreshed)" if fresh else "") + ":")
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
                await ws.send(json.dumps({"t": "pair_request", "proto": PROTO, "label": label}))

        await ws.send(json.dumps({"t": "pair_request", "proto": PROTO, "label": label}))
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
    label = os.environ.get("MACCHIATO_LABEL") or socket.gethostname()
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
