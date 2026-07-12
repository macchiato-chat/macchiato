#!/usr/bin/env python3
"""
GatewayClient — a reusable async client for Hermes's `tui_gateway` JSON-RPC.

Faithful transport only:
  - spawns `<hermes-python> -m tui_gateway.entry` (stdio, newline-framed JSON-RPC)
  - matches request → response by `id` (via futures)
  - surfaces raw events to an `on_event` callback

It deliberately does NOT map tui events into Macchiato's Block model, nor
synthesize message ids. Per docs/design.md, that mapping happens SERVER-side;
the connector stays thin and forwards tui frames verbatim over Link B.

Usage:
    async with GatewayClient(on_event=handler) as gw:
        s = await gw.create_session()
        await gw.submit_prompt(s["session_id"], "hi")

Demo (reproduces the spike via this class):
    python3 services/hermes-connector/gateway_client.py "用一句話打個招呼。"
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any, Callable, Optional

# 連接器按設計就跑在 Hermes venv 的 python 上（install.sh / systemd 用它啟動）→ spawn
# tui_gateway 默認用**自己這個解釋器**（sys.executable），任何安裝佈局（one-liner/pipx/pip/uv）
# 都對。可用 HERMES_PYTHON 環境變量覆蓋。（舊版寫死 pipx 路徑，one-liner 用戶會掛。）
DEFAULT_HERMES_PYTHON = sys.executable

# StreamReader line-buffer limit. tui_gateway frames (e.g. message.complete with
# a large reply, or a big tool result) can exceed asyncio's 64KB default and
# would raise on readline(). 8MB gives generous headroom.
_READ_LIMIT = 8 * 1024 * 1024

# An event handler receives the event's `params` dict: {type, session_id?, payload?}.
# It may be sync or async (an awaitable is scheduled as a task).
EventHandler = Callable[[dict], Any]


class GatewayError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message


class GatewayDied(GatewayError):
    """#4:gateway 進程死亡/傳輸中斷導致的請求失敗——請求**確定沒有完成**（沒收到響應），
    且死亡把在途回合一併帶走。與業務錯誤（gateway 正常回的 error 幀）區分開,
    上層可安全重投(prompt 級重試)。注意 close() 的「client closed」不算——那是主動關停。"""


class GatewayClient:
    def __init__(
        self,
        *,
        hermes_python: Optional[str] = None,
        cwd: Optional[str] = None,
        env: Optional[dict] = None,
        on_event: Optional[EventHandler] = None,
        on_restart: Optional[Callable[[], None]] = None,
        request_timeout: float = 60.0,
    ) -> None:
        self.hermes_python = hermes_python or os.environ.get(
            "HERMES_PYTHON", DEFAULT_HERMES_PYTHON
        )
        self.cwd = cwd or os.getcwd()
        self._extra_env = env
        self.on_event = on_event
        self.on_restart = on_restart
        self.request_timeout = request_timeout

        self._proc: Optional[asyncio.subprocess.Process] = None
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._reader_task: Optional[asyncio.Task] = None
        self._stderr_task: Optional[asyncio.Task] = None
        self._supervise_task: Optional[asyncio.Task] = None
        self._ready = asyncio.Event()
        self._closed = False
        self.restart_failures = 0  # #3 連續重啟失敗計數(健康上報告警)

    # ---- lifecycle ----------------------------------------------------------

    async def _spawn(self) -> None:
        if not os.path.exists(self.hermes_python):
            raise GatewayError(-1, f"hermes python not found: {self.hermes_python}")
        env = os.environ.copy()
        if self._extra_env:
            env.update(self._extra_env)
        env.setdefault("HERMES_PYTHON", self.hermes_python)
        env.setdefault("HERMES_CWD", self.cwd)
        self._ready.clear()
        self._proc = await asyncio.create_subprocess_exec(
            self.hermes_python,
            "-m",
            "tui_gateway.entry",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=self.cwd,
            limit=_READ_LIMIT,
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())

    async def start(self, ready_timeout: float = 20.0) -> None:
        await self._spawn()
        try:
            await asyncio.wait_for(self._ready.wait(), ready_timeout)
        except asyncio.TimeoutError:
            await self.close()
            raise GatewayError(-1, "timed out waiting for gateway.ready")
        self._supervise_task = asyncio.create_task(self._supervise())

    async def _supervise(self) -> None:
        """Respawn the gateway subprocess if it dies unexpectedly; notify via on_restart.
        #3:重啟失敗指數退避(3→60s)——配置壞掉時此前每 3s 死磕無限緊循環;
        restart_failures 供健康上報告警(連續失敗次數上浮 app)。"""
        backoff = 3.0
        while not self._closed:
            proc = self._proc
            if proc is None:
                return
            await proc.wait()
            if self._closed:
                return
            print("[gateway exited unexpectedly; restarting…]", file=sys.stderr)
            for task in (self._reader_task, self._stderr_task):
                if task is not None:
                    task.cancel()
            self._fail_all(GatewayDied(-1, "gateway restarting"))
            try:
                await self._spawn()
                await asyncio.wait_for(self._ready.wait(), 20.0)
            except Exception as exc:
                self.restart_failures += 1
                print(
                    f"[gateway restart failed ×{self.restart_failures}: {exc!r}; retry in {backoff:.0f}s]",
                    file=sys.stderr,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)
                continue
            backoff = 3.0
            self.restart_failures = 0  # 起來了 → 歸零
            print("[gateway restarted; ready]", file=sys.stderr)
            if self.on_restart is not None:
                try:
                    self.on_restart()
                except Exception as exc:
                    print(f"[on_restart error] {exc!r}", file=sys.stderr)

    def is_alive(self) -> bool:
        """gateway 子進程是否在運行（健康上報用）。"""
        return self._proc is not None and self._proc.returncode is None

    def ready(self) -> bool:
        """進程活著且已收到 gateway.ready（重啟期間為 False）。#4 prompt 重投等這個。"""
        return self.is_alive() and self._ready.is_set()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        proc = self._proc
        if proc is not None:
            try:
                if proc.stdin and not proc.stdin.is_closing():
                    proc.stdin.close()
            except Exception:
                pass
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), 5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        for task in (self._supervise_task, self._reader_task, self._stderr_task):
            if task is not None:
                task.cancel()
        self._fail_all(GatewayError(-1, "client closed"))

    async def __aenter__(self) -> "GatewayClient":
        await self.start()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    # ---- io loops -----------------------------------------------------------

    async def _read_stdout(self) -> None:
        assert self._proc and self._proc.stdout
        try:
            while True:
                raw = await self._proc.stdout.readline()
                if not raw:
                    break
                line = raw.strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self._dispatch(frame)
        except asyncio.CancelledError:
            return
        finally:
            self._fail_all(GatewayDied(-1, "gateway stdout closed"))

    async def _read_stderr(self) -> None:
        assert self._proc and self._proc.stderr
        try:
            while True:
                raw = await self._proc.stderr.readline()
                if not raw:
                    break
                # Surface gateway diagnostics ([gateway-exit], [gateway-signal], …).
                text = raw.decode("utf-8", "replace").rstrip()
                if text:
                    print(f"[gateway stderr] {text}", file=sys.stderr)
        except asyncio.CancelledError:
            return

    def _dispatch(self, frame: dict) -> None:
        if frame.get("method") == "event":
            params = frame.get("params") or {}
            if params.get("type") == "gateway.ready":
                self._ready.set()
            self._emit_event(params)
            return
        rid = frame.get("id")
        if rid is None:
            return
        fut = self._pending.pop(rid, None)
        if fut is None or fut.done():
            return
        if "error" in frame:
            err = frame["error"] or {}
            fut.set_exception(GatewayError(err.get("code", -1), err.get("message", "")))
        else:
            fut.set_result(frame.get("result"))

    def _emit_event(self, params: dict) -> None:
        if self.on_event is None:
            return
        try:
            result = self.on_event(params)
            if asyncio.iscoroutine(result):
                asyncio.create_task(result)
        except Exception as exc:  # a bad handler must not kill the reader
            print(f"[on_event error] {exc!r}", file=sys.stderr)

    def _fail_all(self, exc: Exception) -> None:
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    # ---- requests -----------------------------------------------------------

    async def request(
        self, method: str, params: Optional[dict] = None, *, timeout: Optional[float] = None
    ) -> Any:
        proc = self._proc
        if proc is None or proc.stdin is None or self._closed:
            raise GatewayError(-1, "gateway not started")
        self._next_id += 1
        rid = self._next_id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut

        frame = {"jsonrpc": "2.0", "method": method, "params": params or {}, "id": rid}
        try:
            proc.stdin.write((json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8"))
            await proc.stdin.drain()
        except (OSError, ConnectionError) as exc:
            # 死亡窗口期寫入死管道(supervise 尚未換新進程)→ 同樣是「確定沒送達」,歸 GatewayDied。
            self._pending.pop(rid, None)
            raise GatewayDied(-1, f"gateway write failed: {exc!r}")

        try:
            return await asyncio.wait_for(fut, timeout or self.request_timeout)
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            raise GatewayError(-1, f"request timed out: {method}")

    # ---- thin convenience wrappers (typed params live in packages/protocol) --

    async def create_session(self, **params) -> dict:
        return await self.request("session.create", {"cols": 80, **params})

    async def submit_prompt(self, session_id: str, text: str) -> dict:
        return await self.request("prompt.submit", {"session_id": session_id, "text": text})

    async def interrupt(self, session_id: str) -> dict:
        return await self.request("session.interrupt", {"session_id": session_id})

    async def steer(self, session_id: str, text: str) -> dict:
        # 把文字注入正在跑的回合（不打斷）；模型在下一次工具迭代時看到。session busy 時用（方案 D）。
        return await self.request("session.steer", {"session_id": session_id, "text": text})

    async def list_sessions(self, limit: int = 200) -> dict:
        return await self.request("session.list", {"limit": limit})


# --------------------------------------------------------------------------- #
# Demo: reproduce the spike using GatewayClient.
# --------------------------------------------------------------------------- #


async def _demo() -> int:
    prompt = sys.argv[1] if len(sys.argv) > 1 else "用一句話打個招呼。"
    done = asyncio.Event()
    chars = {"n": 0}
    final = {"status": None}

    def on_event(params: dict) -> None:
        etype = params.get("type")
        payload = params.get("payload") or {}
        if etype == "message.delta":
            text = payload.get("text", "")
            chars["n"] += len(text)
            sys.stdout.write(text)
            sys.stdout.flush()
        elif etype in ("tool.start", "tool.complete", "tool.generating"):
            print(f"\n  [tool] {etype}: {payload.get('name')}")
            sys.stdout.write("  reply: ")
        elif etype == "message.complete":
            final["status"] = payload.get("status")
            done.set()
        elif etype in ("approval.request", "clarify.request", "sudo.request", "secret.request"):
            print(f"\n  [needs input] {etype}: {payload}")
            done.set()

    client = GatewayClient(on_event=on_event)
    await client.start()
    print("✓ gateway.ready")

    session = await client.create_session()
    sid = session.get("session_id")
    print(f"✓ session.create -> {sid}\n")
    sys.stdout.write("  reply: ")
    sys.stdout.flush()

    await client.submit_prompt(sid, prompt)

    ok = True
    try:
        await asyncio.wait_for(done.wait(), 100)
    except asyncio.TimeoutError:
        ok = False
        print("\nFAIL: timed out waiting for message.complete")

    await client.close()
    if final["status"] is not None:
        print(f"\n\n✓ message.complete (status={final['status']}); reply chars={chars['n']}")
    print("=" * 56)
    print(f"  RESULT: {'PASS ✓ — GatewayClient 端到端可用' if ok and final['status'] else 'FAIL'}")
    print("=" * 56)
    return 0 if ok and final["status"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_demo()))
