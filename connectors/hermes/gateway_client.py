#!/usr/bin/env python3
"""
GatewayClient — a reusable async client for Hermes's `tui_gateway` JSON-RPC.

Faithful transport only:
  - matches request → response by `id` (via futures)
  - surfaces raw events to an `on_event` callback

Two transports, picked at start (override with MACCHIATO_HERMES_TRANSPORT=stdio|attach):

  stdio   Hermes ≤ 0.22. Spawns `<hermes-python> -m tui_gateway.entry` (newline-framed JSON-RPC)
          and owns that process.
  attach  Hermes ≥ 0.23. One gateway owns each Hermes home, and a standalone `tui_gateway.entry`
          is refused next to it ("owned by a running gateway; attach to it instead"). We ask
          `hermes gateway attach --json` for the gateway's WebSocket URL plus a single-use ticket
          and speak `hermes-gateway-v1` on it. The frames are the same vocabulary, but the session
          verbs moved to the gateway's session authority, so requests and events are translated
          here (see the "attach transport" section) and connector.py keeps talking the stdio-era
          protocol either way.

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
import base64
import collections
import importlib.util
import json
import os
import sys
import uuid
from typing import Any, Callable, Optional

from safe_log import log_content, redact_upstream_line, safe_err

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
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        # hermes-gateway-v1 refusals carry `{reason, revision?, execution_generation?, …}` here.
        self.data = data if isinstance(data, dict) else {}


class GatewayDied(GatewayError):
    """#4:gateway 進程死亡/傳輸中斷導致的請求失敗——請求**確定沒有完成**（沒收到響應），
    且死亡把在途回合一併帶走。與業務錯誤（gateway 正常回的 error 幀）區分開,
    上層可安全重投(prompt 級重試)。注意 close() 的「client closed」不算——那是主動關停。

    只有 stdio 傳輸會拋它。attach 傳輸下斷線**不代表**回合死了(回合活在 gateway 進程裡),
    重投會讓同一句話跑兩遍;那邊改由本類帶著同一個 input_id 在重連後重發(見 `_RESEND_SAFE`)。"""


class _SocketLost(GatewayError):
    """attach transport, internal: the socket went away before the answer came. Never leaves this
    module — `_attach_request` either sends the request again or reports the outcome as unknown."""

    def __init__(self) -> None:
        super().__init__(-1, "gateway connection lost")


# --------------------------------------------------------------------------- #
# attach transport (Hermes ≥ 0.23): `hermes gateway attach` + hermes-gateway-v1
# --------------------------------------------------------------------------- #
#
# What changed upstream, and what this section does about it. connector.py is written against the
# stdio-era protocol and must not have to care:
#
#   session.create     no `cols`; needs `source` (we launch as "tui", the terminal-client policy)
#                      and takes a `request_id` so a retried create returns the same session.
#   prompt.submit      needs an `input_id`. The reply is a durable admission receipt, and repeating
#                      the id returns that same receipt — which is what makes a resend safe.
#   session.steer /    need the `execution_generation` of the turn they act on. We learn it from
#   session.interrupt  the event stream.
#   approval.respond   answered by (`execution_generation`, `prompt_id`) instead of "the oldest one
#   clarify.respond    for this session" / `request_id`. The ids arrive on the *.request events.
#   image.attach       by path is gone on a shared gateway. `image.attach_bytes` only stages the
#                      picture; it rides the next `prompt.submit` as `attachments: [{path, mime}]`.
#   sudo / secret      arrive as server→client *requests* (`{"id": "srq-…", "method": "sudo"}`)
#                      instead of `sudo.request` / `secret.request` events, are answered with a
#                      response frame carrying `{value}`, and are withdrawn with `request.cancel`.
#   archive / rename / `hermes_state.SessionDB` lost those writers; the gateway owns the store and
#   rewind             changes it through `session.mutate`, fenced by the session's `revision` (and
#                      `execution_generation` for anything that touches the transcript). See
#                      `GatewayClient.mutate`.
#   events             same types and payloads, plus bookkeeping fields and a few new change pings
#                      nothing downstream reads.
#   losing the socket  does not end the turn. Re-attach, re-subscribe, replay what was missed.

TRANSPORT_ENV = "MACCHIATO_HERMES_TRANSPORT"  # auto (default) | stdio | attach
HERMES_BIN_ENV = "MACCHIATO_HERMES_BIN"  # the `hermes` launcher to run for `gateway attach`

# hermes-gateway-v1 expects a `gateway.ping` at least this often; it also keeps a gateway that a
# client started (no service installed) from ending itself as idle while we are attached.
_PING_INTERVAL_S = 15.0
_PING_TIMEOUT_S = 30.0
# `hermes gateway attach --start` may have to bring a gateway up first.
_ATTACH_TIMEOUT_S = 150.0
# A `session.resume` answer can carry a long transcript even though we ask it not to.
_WS_MAX_FRAME = 64 * 1024 * 1024

# Events the stdio-era protocol never had and nothing downstream reads. Dropped here instead of
# forwarded: `session.info` alone carries the tool list and the system prompt on every turn.
_ATTACH_DROP_EVENTS = frozenset({
    "sessions.changed", "platforms.changed", "skills.changed", "projects.changed",
    "session.info", "session.usage", "agent.step",
    "approval.settled", "clarify.settled", "session.updated",
    # Every pending approval dropped by an interrupt / reap, in one frame. The turn's end closes
    # those cards on the server anyway (#636); forwarded, it would only be logged as unknown.
    "approval.cancelled",
})

# Requests that are safe to send again after the socket was lost with the answer outstanding:
# each carries an id the gateway deduplicates on, or is a read.
_RESEND_SAFE = frozenset({
    "session.create", "session.resume", "prompt.submit", "session.interrupt",
    "approval.respond", "clarify.respond", "commands.catalog", "session.list",
    "runtime.describe", "session.events.since", "session.mutate",
})

# `session.mutate` operations fenced by `execution_generation` as well as `revision`: they change the
# transcript or the running policy, so the gateway wants them on a session this socket holds.
_GENERATION_FENCED = frozenset({
    "rewind", "reset", "branch", "delete", "compress", "model", "reasoning", "workspace",
    "editor_mcp", "edit_policy",
})

# stdio-era approval answers → the choices a gateway offers (`once`, `session`, `always`, `deny`).
# The app's cards send yes / no / always; `always` already is a gateway choice and passes through.
_APPROVAL_CHOICES = {"yes": "once", "y": "once", "approve": "once", "allow": "once", "no": "deny", "n": "deny"}

# Server→client requests we answer, and the field of the stdio-era `*.respond` that holds the value.
# The gateway sends each one to every viewer attached to the session and takes the FIRST answer —
# an error answer included, which settles it as skipped for everyone. Any other request is refused
# at once (see `_attach_dispatch`).
_ANSWERED_REQUESTS = {"sudo": "password", "secret": "value"}
# How many staged pictures one prompt may carry (Desktop's composer limit).
_MAX_PROMPT_IMAGES = 10


def hermes_root() -> Optional[str]:
    """Directory of the Hermes checkout this interpreter resolves, or None when there is none.
    `find_spec` on a top-level module locates it without importing anything."""
    try:
        spec = importlib.util.find_spec("hermes_constants")
    except (ImportError, ValueError):
        return None
    origin = getattr(spec, "origin", None) if spec is not None else None
    return os.path.dirname(os.path.abspath(origin)) if origin else None


def hermes_requires_attach(root: Optional[str] = None) -> bool:
    """True when this Hermes runs the shared session authority (0.23.0+): its gateway owns every
    session, refuses a standalone `tui_gateway.entry` beside it, and speaks the hermes-gateway-v1
    this module translates. `hermes gateway attach` itself is older (0.21.5), but on 0.21.5–0.22.x
    the stdio entry still works and is what those versions were tested with — so the marker is the
    authority, not the attach command."""
    root = root if root is not None else hermes_root()
    return bool(root) and os.path.isfile(os.path.join(root, "gateway", "session_controls.py"))


def select_transport() -> str:
    mode = (os.environ.get(TRANSPORT_ENV) or "auto").strip().lower()
    if mode in ("stdio", "attach"):
        return mode
    return "attach" if hermes_requires_attach() else "stdio"


class AttachState:
    """What the attach transport has to remember between frames. No I/O: `observe` takes an event's
    params and returns the stdio-era params to hand on (or None to drop it); `request` rewrites an
    outgoing stdio-era request. Kept separate from the socket so it can be tested on its own."""

    def __init__(self, client_version: Optional[str] = None) -> None:
        self.client_version = client_version
        self.create_parameters: frozenset = frozenset()  # runtime.describe session_create.parameters
        self.generation: dict[str, int] = {}  # session → newest execution_generation seen
        self.revision: dict[str, int] = {}  # session → newest revision seen (the session.mutate fence)
        self.seq: dict[str, int] = {}  # session → last event seq delivered
        self.replay_epoch: dict[str, str] = {}  # session → the epoch those seqs belong to
        self.inflight: set[str] = set()  # sessions between message.start and message.complete
        self.approvals: dict[str, collections.deque] = {}  # session → (prompt_id, generation), oldest first
        self.answering: dict[str, str] = {}  # prompt_id → session: answered by us, not yet settled
        self.clarifies: dict[str, tuple] = {}  # request_id → (session, generation, prompt_id)
        self.subscribed: set[str] = set()  # sessions this socket receives events for
        self.server_requests: dict[str, tuple] = {}  # srq id → (session, "sudo" | "secret"), unanswered
        self.answered: collections.deque = collections.deque(maxlen=64)  # srq ids we already answered
        self.staged_images: dict[str, list] = {}  # session → [{path, mime}] for its next prompt

    def reset_connection(self) -> None:
        """The socket is gone: subscriptions die with it. Everything else describes the gateway,
        which may well still be running the same turns."""
        self.subscribed.clear()

    def reset_gateway(self) -> None:
        """A different gateway process answers now: nothing learned from the old one holds."""
        self.subscribed.clear()
        self.generation.clear()
        self.revision.clear()
        self.seq.clear()
        self.replay_epoch.clear()
        self.inflight.clear()
        self.approvals.clear()
        self.answering.clear()
        self.clarifies.clear()
        self.server_requests.clear()
        self.answered.clear()
        self.staged_images.clear()

    # ---- events -------------------------------------------------------------

    def observe(self, params: dict) -> Optional[dict]:
        etype = params.get("type")
        sid = params.get("session_id")
        payload = params.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        gen = params.get("execution_generation")
        if type(gen) is not int:
            gen = payload.get("execution_generation")
        if sid and type(gen) is int and gen > self.generation.get(sid, -1):
            self.generation[sid] = gen
        if etype == "session.updated" and sid:
            self.learn_revision(sid, payload.get("revision"))
        seq = params.get("seq")
        if sid and type(seq) is int:
            epoch = params.get("replay_epoch")
            if isinstance(epoch, str) and epoch:
                if self.replay_epoch.get(sid) not in (None, epoch):
                    self.seq.pop(sid, None)  # a new epoch numbers from the start again
                self.replay_epoch[sid] = epoch
            if seq <= self.seq.get(sid, 0):
                return None  # already delivered (a replay overlapping the live stream)
            self.seq[sid] = seq

        if etype == "message.start" and sid:
            self.inflight.add(sid)
        elif etype == "message.complete" and sid:
            self.inflight.discard(sid)
            # A finished turn cannot still be waiting on an answer.
            self.approvals.pop(sid, None)
            for rid in [r for r, (s, _g, _p) in self.clarifies.items() if s == sid]:
                del self.clarifies[rid]
            for pid in [p for p, s in self.answering.items() if s == sid]:
                del self.answering[pid]
            for rid in [r for r, (s, _k) in self.server_requests.items() if s == sid]:
                del self.server_requests[rid]
        elif etype == "request.cancel":
            # A sudo / secret question withdrawn: answered by another viewer (`resolved`), timed out,
            # or the turn was interrupted. Close the card the way the stdio protocol did.
            rid = payload.get("id")
            known = self.server_requests.pop(rid, None) if isinstance(rid, str) else None
            if known is None:
                return None  # not one we handed on (an approval / clarify card, or already closed)
            asked_in, kind = known
            return {"type": f"{kind}.expire", "session_id": asked_in,
                    "payload": {"request_id": rid, "reason": payload.get("reason")}}
        elif etype == "approval.request" and sid:
            prompt_id = payload.get("prompt_id")
            if prompt_id:
                asked_in = gen if type(gen) is int else self.generation.get(sid, 0)
                self.approvals.setdefault(sid, collections.deque()).append((prompt_id, asked_in))
            # The stdio-era payload always carried these two; downstream types them as required.
            payload = {"pattern_key": "", "pattern_keys": [], **payload}
            if prompt_id and not payload.get("request_id"):
                # The server keeps it on the card and sends it back with the answer, so the answer
                # lands on this card rather than the oldest one of the session (and a card settled
                # elsewhere can be found and closed).
                payload["request_id"] = prompt_id
        elif etype == "approval.settled" and sid:
            prompt_id = payload.get("prompt_id")
            queue = self.approvals.get(sid)
            was_waiting = bool(queue) and any(item[0] == prompt_id for item in queue)
            if queue:
                self.approvals[sid] = collections.deque(item for item in queue if item[0] != prompt_id)
            ours = self.answering.pop(prompt_id, None) is not None
            if was_waiting and not ours:
                # Answered by another viewer of this session (a terminal, Desktop): close our card.
                return {"type": "approval.expire", "session_id": sid,
                        "payload": {"request_id": prompt_id, "reason": "resolved"}}
            return None
        elif etype == "clarify.request" and sid:
            prompt_id = payload.get("prompt_id")
            request_id = payload.get("request_id") or prompt_id
            if request_id:
                asked_in = gen if type(gen) is int else self.generation.get(sid, 0)
                self.clarifies[str(request_id)] = (sid, asked_in, prompt_id or request_id)
                payload = {**payload, "request_id": request_id}
        elif etype == "clarify.settled":
            prompt_id = payload.get("prompt_id")
            waiting = [(r, s) for r, (s, _g, p) in self.clarifies.items() if p == prompt_id]
            for rid, _s in waiting:
                del self.clarifies[rid]
            ours = self.answering.pop(prompt_id, None) is not None
            if waiting and not ours:
                rid, asked_in = waiting[0]
                return {"type": "clarify.expire", "session_id": sid or asked_in,
                        "payload": {"request_id": rid, "reason": "resolved"}}
            return None

        if etype in _ATTACH_DROP_EVENTS:
            return None
        out: dict = {"type": etype}
        if "session_id" in params:
            out["session_id"] = sid
        if "payload" in params:
            out["payload"] = payload if isinstance(params.get("payload"), dict) else params.get("payload")
        return out

    def learn_revision(self, sid: Any, revision: Any) -> None:
        if isinstance(sid, str) and sid and type(revision) is int and revision > self.revision.get(sid, -1):
            self.revision[sid] = revision

    # ---- server→client requests ---------------------------------------------

    def server_request(self, frame: dict) -> Optional[dict]:
        """A sudo / secret question the gateway sent us (live, or handed back in a snapshot's
        `open_requests`). Returns the stdio-era event that asks it, or None when it is not one we
        answer or was already asked."""
        method, rid = frame.get("method"), frame.get("id")
        params = frame.get("params") if isinstance(frame.get("params"), dict) else {}
        sid = params.get("session_id")
        if method not in _ANSWERED_REQUESTS or not isinstance(rid, str) or not rid or not sid:
            return None
        if rid in self.server_requests or rid in self.answered:
            return None
        self.server_requests[rid] = (sid, method)
        if method == "sudo":
            payload = {"request_id": rid}
            if isinstance(params.get("command"), str):
                payload["command"] = params["command"]
        else:
            payload = {"request_id": rid, "prompt": params.get("prompt") or "", "env_var": params.get("env_var") or ""}
            if isinstance(params.get("metadata"), dict):
                payload["metadata"] = params["metadata"]
        return {"type": f"{method}.request", "session_id": sid, "payload": payload}

    def answer(self, method: str, params: dict) -> tuple[str, dict]:
        """A stdio-era `sudo.respond` / `secret.respond` → (srq id, response result). The value
        travels only in that response frame. Raises GatewayError when nothing waits for it."""
        rid = str(params.get("request_id") or "")
        known = self.server_requests.pop(rid, None)
        if known is None or known[1] != method.split(".", 1)[0]:
            if known is not None:
                self.server_requests[rid] = known
            raise GatewayError(-1, "that question is no longer waiting for an answer")
        value = params.get(_ANSWERED_REQUESTS[known[1]])
        self.answered.append(rid)
        return rid, {"value": value if isinstance(value, str) else ""}

    # ---- requests -----------------------------------------------------------

    def request(self, method: str, params: dict) -> tuple[str, dict]:
        """Rewrite one stdio-era request for the gateway. Raises GatewayError when it cannot be
        expressed (no running turn to steer, no question waiting for that answer)."""
        p = dict(params)
        sid = p.get("session_id")
        if method == "session.create":
            p.pop("cols", None)
            p.setdefault("source", "tui")
            p.setdefault("request_id", uuid.uuid4().hex)
            if "client" in self.create_parameters:
                client = {"name": "macchiato"}
                if self.client_version:
                    client["version"] = self.client_version
                p.setdefault("client", client)
            if self.create_parameters:
                # An option this gateway does not take is left out rather than refused.
                p = {k: v for k, v in p.items() if k in self.create_parameters}
        elif method == "session.resume":
            p.pop("cols", None)
            p.setdefault("omit_messages", True)  # we only need the subscription, not the transcript
        elif method == "prompt.submit":
            p.setdefault("input_id", uuid.uuid4().hex)
            staged = self.staged_images.pop(sid, None) if sid else None
            if staged and "attachments" not in p:
                # Pictures staged by `image.attach_bytes` reach the model only through this list.
                p["attachments"] = staged[:_MAX_PROMPT_IMAGES]
        elif method in ("session.steer", "session.redirect"):
            if sid not in self.inflight or sid not in self.generation:
                raise GatewayError(4009, "no running turn to steer")
            p = {"session_id": sid, "text": p.get("text"), "execution_generation": self.generation[sid]}
        elif method == "session.interrupt":
            p.setdefault("execution_generation", self.generation.get(sid, 0))
        elif method == "approval.respond":
            queue = self.approvals.get(sid)
            if not queue:
                raise GatewayError(-1, "no approval is waiting for an answer in this session")
            # The card's own id when the server sent it back (we handed it out as request_id);
            # the oldest card of the session only when the card carries no id at all (one asked
            # before this connector handed ids out), as the stdio protocol answered.
            wanted = p.get("request_id")
            if isinstance(wanted, str) and wanted:
                item = next((item for item in queue if item[0] == wanted), None)
                if item is None:
                    # Every waiting card here carries its prompt id, so an id we no longer hold
                    # was settled elsewhere (a terminal / Desktop viewing the same session). Never
                    # hand this decision to another card: it would approve a command nobody saw.
                    raise GatewayError(-1, "that approval is no longer waiting for an answer")
            else:
                item = queue[0]
            prompt_id, gen = item
            self.answering[prompt_id] = sid
            choice = str(p.get("choice") or "deny").strip().lower()
            p = {"session_id": sid, "execution_generation": gen, "prompt_id": prompt_id,
                 "choice": _APPROVAL_CHOICES.get(choice, choice)}
        elif method == "clarify.respond":
            request_id = str(p.get("request_id") or "")
            known = self.clarifies.get(request_id)
            if known is None:
                raise GatewayError(-1, "no clarify question is waiting for that answer")
            csid, gen, prompt_id = known
            self.answering[prompt_id] = csid
            rest = {k: v for k, v in p.items() if k not in ("request_id", "session_id")}
            p = {"session_id": csid, "execution_generation": gen, "prompt_id": prompt_id, **rest}
        elif method == "session.cwd.set":
            # A session's working directory is fixed when it is created on this Hermes. 4009 is
            # what the stdio protocol answered while a session was busy, and callers already
            # treat it as "not now": the directory still applies to the next session created.
            raise GatewayError(4009, "the working directory is fixed at session creation on this Hermes")
        elif method == "image.attach" and isinstance(p.get("path"), str):
            path = p.pop("path")
            try:
                with open(path, "rb") as fh:
                    data = fh.read()
            except OSError as exc:
                raise GatewayError(-1, f"cannot read attachment: {exc!r}")
            method = "image.attach_bytes"
            p.update(content_base64=base64.b64encode(data).decode("ascii"), filename=os.path.basename(path))
        return method, p

    def settled(self, method: str, sent: dict, result: Any) -> list:
        """Bookkeeping once the gateway answered a request we rewrote. Returns stdio-era events to
        hand on (a session snapshot can carry sudo / secret questions still waiting)."""
        out: list = []
        if method == "approval.respond":
            sid = sent.get("session_id")
            queue = self.approvals.get(sid)
            if queue:
                self.approvals[sid] = collections.deque(item for item in queue if item[0] != sent.get("prompt_id"))
        elif method == "clarify.respond":
            for rid in [r for r, (_s, _g, p) in self.clarifies.items() if p == sent.get("prompt_id")]:
                del self.clarifies[rid]
        elif method in ("session.create", "session.resume") and isinstance(result, dict):
            sid = result.get("session_id")
            if sid:
                self.subscribed.add(sid)
                gen = result.get("execution_generation")
                if type(gen) is int and gen > self.generation.get(sid, -1):
                    self.generation[sid] = gen
                self.learn_revision(sid, result.get("revision"))
                if result.get("running") is False:
                    self.inflight.discard(sid)
                for entry in result.get("open_requests") or []:
                    if isinstance(entry, dict):
                        params = entry.get("params") if isinstance(entry.get("params"), dict) else {}
                        event = self.server_request({**entry, "params": {"session_id": sid, **params}})
                        if event is not None:
                            out.append(event)
        elif method == "session.mutate" and isinstance(result, dict):
            sid = result.get("session_id") or sent.get("session_id")
            self.learn_revision(sid, result.get("revision"))
            gen = result.get("execution_generation")
            if sid and type(gen) is int and gen > self.generation.get(sid, -1):
                self.generation[sid] = gen
        elif method == "image.attach_bytes" and isinstance(result, dict):
            sid = sent.get("session_id")
            if sid and isinstance(result.get("path"), str) and isinstance(result.get("mime"), str):
                self.staged_images.setdefault(sid, []).append({"path": result["path"], "mime": result["mime"]})
        elif method in ("session.steer", "session.redirect") and isinstance(result, dict):
            if result.get("status") != "rejected":
                # The text went into the running turn; a steer carries no pictures, so ones staged
                # for it must not ride along with whatever prompt comes next.
                self.staged_images.pop(sent.get("session_id"), None)
        return out


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
        client_version: Optional[str] = None,
        transport: Optional[str] = None,
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

        # attach transport (Hermes ≥ 0.23). `transport` is decided in start(), not here: by then the
        # environment the connector runs in is final.
        self.transport: Optional[str] = transport
        self._attach = AttachState(client_version)
        self._ws: Any = None
        self._ws_lost: Optional[asyncio.Event] = None
        self._attach_up: Optional[asyncio.Event] = None  # set once (re)attached and caught up
        self._ping_task: Optional[asyncio.Task] = None
        self._instance_id: Optional[str] = None
        self._sent: dict[int, tuple] = {}  # request id → (method, sent params) while unanswered
        self._resume_locks: dict[str, asyncio.Lock] = {}

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
        if self.transport is None:
            self.transport = select_transport()
        if self.transport == "attach":
            await self._attach_start()
            return
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
                    f"[gateway restart failed ×{self.restart_failures}: {safe_err(exc)}; retry in {backoff:.0f}s]",
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
                    print(f"[on_restart error] {safe_err(exc)}", file=sys.stderr)

    def is_alive(self) -> bool:
        """gateway 子進程是否在運行（健康上報用）。attach 傳輸:與 gateway 的連線是否還在。"""
        if self.transport == "attach":
            return self._ws is not None and self._ws_lost is not None and not self._ws_lost.is_set()
        return self._proc is not None and self._proc.returncode is None

    def ready(self) -> bool:
        """進程活著且已收到 gateway.ready（重啟期間為 False）。#4 prompt 重投等這個。
        attach 傳輸:連上且重連後的善後(重新訂閱在途回合)已做完。"""
        if self.transport == "attach":
            return self.is_alive() and self._attach_up is not None and self._attach_up.is_set()
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
        ws, self._ws = self._ws, None
        if ws is not None:
            # Only our socket: the gateway keeps running for everything else attached to it.
            try:
                await asyncio.wait_for(ws.close(), 5)
            except Exception:
                pass
        for task in (self._supervise_task, self._reader_task, self._stderr_task, self._ping_task):
            if task is not None:
                task.cancel()
        self._fail_all(GatewayError(-1, "client closed"))
        self._sent.clear()

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
                # #381:默认脱敏——agent 错误/堆栈/路径不得原样进 journald。
                text = raw.decode("utf-8", "replace").rstrip()
                if text:
                    print(f"[gateway stderr] {redact_upstream_line(text)}", file=sys.stderr)
                    log_content("gateway.stderr", text)
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
            fut.set_exception(GatewayError(err.get("code", -1), err.get("message", ""), err.get("data")))
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
            print(f"[on_event error] {safe_err(exc)}", file=sys.stderr)

    def _fail_all(self, exc: Exception) -> None:
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    # ---- requests -----------------------------------------------------------

    async def request(
        self, method: str, params: Optional[dict] = None, *, timeout: Optional[float] = None
    ) -> Any:
        if self.transport == "attach":
            return await self._attach_request(method, params or {}, timeout or self.request_timeout)
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

    # ---- attach transport ----------------------------------------------------

    def _attach_argv(self, flag: str) -> list[str]:
        override = (os.environ.get(HERMES_BIN_ENV) or "").strip()
        if override:
            base = [override]
        else:
            root = hermes_root()
            launcher = os.path.join(root, ".hermes", "bin", "hermes") if root else ""
            if launcher and os.access(launcher, os.X_OK):
                base = [launcher]  # the checkout's own launcher: right interpreter, right environment
            else:
                base = [self.hermes_python, "-m", "hermes_cli.main"]
        return [*base, "gateway", "attach", "--json", flag]

    async def _attach_once(self, flag: str) -> dict:
        """Run `hermes gateway attach` once. The answer holds a single-use ticket: never log it."""
        env = os.environ.copy()
        if self._extra_env:
            env.update(self._extra_env)
        try:
            proc = await asyncio.create_subprocess_exec(
                *self._attach_argv(flag),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                cwd=self.cwd,
            )
        except OSError as exc:
            raise GatewayError(-1, f"cannot run hermes gateway attach: {exc!r}")
        try:
            out, err = await asyncio.wait_for(proc.communicate(), _ATTACH_TIMEOUT_S)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            raise GatewayError(-1, "hermes gateway attach timed out")
        info = None
        for line in reversed(out.decode("utf-8", "replace").splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    info = json.loads(line)
                except json.JSONDecodeError:
                    continue
                break
        usable = isinstance(info, dict) and info.get("url") and info.get("protocols")
        if proc.returncode != 0 or not usable:
            # Non-zero exit = no gateway to attach to; the verdict is on stdout, the reason on stderr.
            verdict = ""
            if isinstance(info, dict):
                verdict = f" {info.get('state')}/{info.get('reason_code')}"
            tail = err.decode("utf-8", "replace").strip().splitlines()[-1:] or [""]
            log_content("gateway.attach", tail[0])
            raise GatewayError(
                -1, f"hermes gateway attach failed (exit {proc.returncode}{verdict}) {redact_upstream_line(tail[0])}"
            )
        return info

    async def _attach_connect(self, flag: str, ready_timeout: float = 20.0) -> None:
        import websockets  # the connector already depends on it for Link B

        info = await self._attach_once(flag)
        options = dict(
            subprotocols=info["protocols"], max_size=_WS_MAX_FRAME, open_timeout=20, ping_interval=20, ping_timeout=30
        )
        try:
            # A loopback peer must never be dialled through the user's HTTP(S) proxy.
            ws = await websockets.connect(info["url"], proxy=None, **options)
        except TypeError:  # websockets < 15 has no `proxy` option (and never used one)
            ws = await websockets.connect(info["url"], **options)
        lost = asyncio.Event()
        self._ws, self._ws_lost = ws, lost
        self._ready.clear()
        self._reader_task = asyncio.create_task(self._attach_read(ws, lost))
        try:
            await asyncio.wait_for(self._ready.wait(), ready_timeout)
            described = await self._attach_send("runtime.describe", {}, ready_timeout)
        except BaseException:
            lost.set()
            self._reader_task.cancel()
            try:
                await ws.close()
            except Exception:
                pass
            raise
        described = described if isinstance(described, dict) else {}
        contract = described.get("session_create")
        contract = contract if isinstance(contract, dict) else {}
        self._attach.create_parameters = frozenset(contract.get("parameters") or ())
        endpoint = info.get("endpoint") if isinstance(info.get("endpoint"), dict) else {}
        self._instance_id = described.get("instance_id") or endpoint.get("instance_id")
        self._ping_task = asyncio.create_task(self._attach_ping(ws, lost))

    async def _attach_start(self) -> None:
        self._attach_up = asyncio.Event()
        delay, last = 2.0, None
        for attempt in range(4):
            if attempt:
                # The gateway may be mid-restart (an update, a reboot ordering race). Dying here
                # would only make the supervisor start us again against the same gateway.
                print(f"[gateway attach failed: {safe_err(last)}; retry in {delay:.0f}s]", file=sys.stderr)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)
            try:
                await self._attach_connect("--recover" if attempt else "--start")
                break
            except (GatewayError, OSError, asyncio.TimeoutError) as exc:
                last = exc
            except Exception as exc:  # websockets handshake errors, and whatever else connecting raises
                last = exc
        else:
            await self.close()
            if isinstance(last, GatewayError):
                raise last
            raise GatewayError(-1, f"cannot attach to the hermes gateway: {safe_err(last)}")
        self._attach_up.set()
        self._supervise_task = asyncio.create_task(self._attach_supervise())

    async def _attach_read(self, ws: Any, lost: asyncio.Event) -> None:
        try:
            async for raw in ws:
                try:
                    frame = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                if isinstance(frame, dict):
                    self._attach_dispatch(frame, ws)
        except asyncio.CancelledError:
            return
        except Exception:
            pass  # a closed or broken socket: the supervisor re-attaches
        finally:
            lost.set()

    def _attach_dispatch(self, frame: dict, ws: Any) -> None:
        if frame.get("method") == "event":
            params = frame.get("params")
            params = params if isinstance(params, dict) else {}
            if params.get("type") == "gateway.ready":
                self._ready.set()
            out = self._attach.observe(params)
            if out is not None:
                self._emit_event(out)
            return
        rid = frame.get("id")
        if "method" in frame:
            if rid is None:
                return
            if frame.get("method") in _ANSWERED_REQUESTS:
                # sudo / secret: ask the app. Never refuse these — the gateway takes the first
                # answer from any viewer, so a refusal would skip the prompt for a terminal that is
                # showing it too. Nobody answering ends it at the gateway's own timeout.
                out = self._attach.server_request(frame)
                if out is not None:
                    self._emit_event(out)
                return
            # Anything else (a batch clarify form, Desktop's vault / window / theme requests) has no
            # card in the app. Refuse it so an app-driven turn goes on at once instead of waiting out
            # the gateway's timeout; the cost is that a terminal attached to the same session loses
            # that one form too.
            asyncio.create_task(self._attach_refuse(ws, rid))
            return
        if rid is None:
            return
        fut = self._pending.pop(rid, None)
        sent = self._sent.pop(rid, None)
        if fut is None or fut.done():
            return
        if "error" in frame:
            err = frame["error"] or {}
            fut.set_exception(GatewayError(err.get("code", -1), err.get("message", ""), err.get("data")))
            return
        result = frame.get("result")
        follow_ups = self._attach.settled(sent[0], sent[1], result) if sent is not None else []
        fut.set_result(result)
        for out in follow_ups:
            self._emit_event(out)

    async def _attach_refuse(self, ws: Any, rid: Any) -> None:
        reply = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "not supported by this client"}}
        try:
            await ws.send(json.dumps(reply))
        except Exception:
            pass

    async def _attach_ping(self, ws: Any, lost: asyncio.Event) -> None:
        try:
            while not lost.is_set():
                await asyncio.sleep(_PING_INTERVAL_S)
                await self._attach_send("gateway.ping", {}, _PING_TIMEOUT_S)
        except asyncio.CancelledError:
            return
        except Exception:
            # No answer on a socket that still looks open: drop it so the supervisor re-attaches.
            lost.set()
            try:
                await ws.close()
            except Exception:
                pass

    async def _attach_supervise(self) -> None:
        """Re-attach when the socket goes away. Losing it says nothing about the turns: the gateway
        runs them. Only a *different* gateway process means they are gone (`on_restart`)."""
        backoff = 1.0
        while not self._closed:
            lost = self._ws_lost
            if lost is None:
                return
            await lost.wait()
            if self._closed:
                return
            self._attach_up.clear()
            print("[gateway connection lost; re-attaching…]", file=sys.stderr)
            for task in (self._reader_task, self._ping_task):
                if task is not None:
                    task.cancel()
            self._fail_all(_SocketLost())
            self._sent.clear()
            self._attach.reset_connection()
            previous = self._instance_id
            while not self._closed:
                try:
                    await self._attach_connect("--recover")
                    if self._instance_id == previous:
                        await self._attach_recover()
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.restart_failures += 1
                    print(
                        f"[gateway re-attach failed ×{self.restart_failures}: {safe_err(exc)}; retry in {backoff:.0f}s]",
                        file=sys.stderr,
                    )
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 30.0)
            if self._closed:
                return
            backoff = 1.0
            self.restart_failures = 0
            if self._instance_id != previous:
                self._attach.reset_gateway()
                print("[gateway restarted; re-attached]", file=sys.stderr)
                if self.on_restart is not None:
                    try:
                        self.on_restart()
                    except Exception as exc:
                        print(f"[on_restart error] {safe_err(exc)}", file=sys.stderr)
            else:
                print("[gateway connection restored]", file=sys.stderr)
            self._attach_up.set()

    async def _attach_recover(self) -> None:
        """Same gateway, new socket: pick the running turns back up. Ask for the events we missed
        first (that also tells the gateway this is a reconnect, not a new viewer), then
        re-subscribe. Idle sessions are re-subscribed when they are next used."""
        for sid in list(self._attach.inflight):
            cursor: dict = {"session_id": sid, "last_sequence": self._attach.seq.get(sid, 0)}
            if sid in self._attach.replay_epoch:
                cursor["replay_epoch"] = self._attach.replay_epoch[sid]
            try:
                replay = await self._attach_send("session.events.since", cursor, 30.0)
                for frame in (replay or {}).get("events") or []:
                    if not isinstance(frame, dict):
                        continue
                    params = frame.get("params") if isinstance(frame.get("params"), dict) else frame
                    out = self._attach.observe(params)
                    if out is not None:
                        self._emit_event(out)
                ended_unseen = sid in self._attach.inflight
                snapshot = await self._attach_send("session.resume", {"session_id": sid, "omit_messages": True}, 30.0)
                ended_unseen = ended_unseen and isinstance(snapshot, dict) and snapshot.get("running") is False
            except _SocketLost:
                raise
            except GatewayError as exc:
                print(f"[gateway re-attach: could not resume a running session: {safe_err(exc)}]", file=sys.stderr)
                ended_unseen = True
                self._attach.inflight.discard(sid)
            if ended_unseen:
                # The turn finished while we were away and the gateway no longer holds its last
                # event. Close it for the app; the reply itself is in the transcript.
                self._emit_event({
                    "type": "message.complete",
                    "session_id": sid,
                    "payload": {"text": "", "status": "error", "usage": {},
                                "warning": "與 Hermes 的連線中斷，沒收到這一回合的結尾——回覆若已完成，會出現在對話歷史裡"},
                })

    async def _attach_send(self, method: str, params: dict, timeout: float) -> Any:
        """One frame out, its answer back. `_SocketLost` when the socket is (or goes) away first."""
        ws, lost = self._ws, self._ws_lost
        if ws is None or lost is None or lost.is_set():
            raise _SocketLost()
        self._next_id += 1
        rid = self._next_id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        self._sent[rid] = (method, params)
        frame = {"jsonrpc": "2.0", "method": method, "params": params, "id": rid}
        try:
            await ws.send(json.dumps(frame, ensure_ascii=False))
        except Exception as exc:
            self._pending.pop(rid, None)
            self._sent.pop(rid, None)
            raise _SocketLost() from exc
        try:
            return await asyncio.wait_for(fut, max(timeout, 0.1))
        except asyncio.TimeoutError:
            self._pending.pop(rid, None)
            self._sent.pop(rid, None)
            raise GatewayError(-1, f"request timed out: {method}")

    async def _attach_subscribe(self, sid: str, timeout: float) -> None:
        """Events only reach a socket that resumed (or created) the session on this connection."""
        lock = self._resume_locks.setdefault(sid, asyncio.Lock())
        async with lock:
            if sid in self._attach.subscribed:
                return
            try:
                await self._attach_send("session.resume", {"session_id": sid, "omit_messages": True}, timeout)
            except _SocketLost:
                raise
            except GatewayError:
                pass  # e.g. not_found: let the request that needed it report that itself

    async def _attach_answer(self, method: str, params: dict, timeout: float) -> dict:
        """`sudo.respond` / `secret.respond`: a response frame to the gateway's own request — there is
        no reply to wait for. A socket lost on the way is retried once we are back: the gateway keeps
        the question open (same process) and the srq id stays valid."""
        rid, result = self._attach.answer(method, params)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        frame = json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}, ensure_ascii=False)
        while True:
            remaining = deadline - loop.time()
            if self._closed:
                raise GatewayError(-1, "client closed")
            if remaining <= 0:
                raise GatewayError(-1, f"hermes gateway not reachable: {method}")
            if not self.ready():
                try:
                    await asyncio.wait_for(self._attach_up.wait(), remaining)
                except asyncio.TimeoutError:
                    raise GatewayError(-1, f"hermes gateway not reachable: {method}")
                continue
            try:
                await self._ws.send(frame)
            except Exception:
                await asyncio.sleep(0.05)
                continue
            return {"ok": True}

    async def _attach_request(self, method: str, params: dict, timeout: float) -> Any:
        if self._closed or self._ws_lost is None:
            raise GatewayError(-1, "gateway not started")
        if method in ("sudo.respond", "secret.respond"):
            return await self._attach_answer(method, params, timeout)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        # Rewritten once: a resend after a reconnect carries the same input_id / request_id, which
        # is what lets the gateway answer it with the first attempt's receipt instead of acting twice.
        wire_method, wire_params = self._attach.request(method, params)
        sid = wire_params.get("session_id")
        refresh_generation = refreshed = False
        while True:
            remaining = deadline - loop.time()
            if self._closed:
                raise GatewayError(-1, "client closed")
            if remaining <= 0:
                raise GatewayError(-1, f"request timed out: {method}")
            if not self.ready():
                try:
                    await asyncio.wait_for(self._attach_up.wait(), remaining)
                except asyncio.TimeoutError:
                    raise GatewayError(-1, f"hermes gateway not reachable: {method}")
                continue
            try:
                if (
                    isinstance(sid, str)
                    and sid
                    and wire_method not in ("session.create", "session.resume", "session.mutate")
                    and sid not in self._attach.subscribed
                ):
                    await self._attach_subscribe(sid, remaining)
                if refresh_generation:
                    refresh_generation = False
                    wire_params["execution_generation"] = self._attach.generation.get(sid, 0)
                result = await self._attach_send(wire_method, wire_params, deadline - loop.time())
            except _SocketLost:
                if wire_method in _RESEND_SAFE:
                    await asyncio.sleep(0.05)  # let the supervisor notice before we wait on it
                    continue
                raise GatewayError(-1, f"hermes gateway connection lost during {method}; outcome unknown")
            except GatewayError as exc:
                if wire_method == "session.interrupt" and exc.message == "stale_generation":
                    if not refreshed:
                        # Our idea of the running turn is old: re-read it (the resume at the top of
                        # the loop brings the current generation) and try once more.
                        refreshed = refresh_generation = True
                        self._attach.subscribed.discard(sid)
                        continue
                    return {"status": "idle"}  # nothing is running: the stdio-era answer for that
                raise
            break
        if wire_method in ("session.steer", "session.redirect") and isinstance(result, dict):
            if result.get("status") == "rejected":
                # Not delivered to the running turn. Say so the way the stdio protocol did, so the
                # caller queues it as the next prompt instead of dropping it.
                raise GatewayError(4009, "steer not delivered")
        return result

    async def mutate(self, session_id: str, operation: str, payload: dict, *, timeout: Optional[float] = None) -> dict:
        """`session.mutate` (attach transport only): archive, rename, rewind, … a stored session.

        The gateway fences every write by the session's `revision`, and transcript / policy changes
        also by its `execution_generation`. We send what we last saw (0 when we never saw it); a
        stale fence is refused with the current values in `error.data`, and we try once more with
        those. A generation-fenced operation needs the session held by this socket, so it is resumed
        first. A fresh `request_id` per attempt: the gateway answers a repeated id with the first
        attempt's receipt, and with `admission_conflict` when the fences in it changed."""
        if self.transport != "attach":
            raise GatewayError(-32601, "session.mutate needs Hermes 0.23 or newer")
        fenced = operation in _GENERATION_FENCED
        resumed = False
        last: Optional[GatewayError] = None
        for _attempt in range(4):
            if fenced and not resumed:
                resumed = True
                if session_id not in self._attach.subscribed:
                    await self.request("session.resume", {"session_id": session_id}, timeout=timeout)
            params = {
                "session_id": session_id,
                "request_id": uuid.uuid4().hex,
                "expected_revision": self._attach.revision.get(session_id, 0),
                "operation": operation,
                "payload": payload,
            }
            if fenced:
                params["expected_generation"] = self._attach.generation.get(session_id, 0)
            try:
                return await self.request("session.mutate", params, timeout=timeout)
            except GatewayError as exc:
                last = exc
                reason = exc.data.get("reason") or exc.message
                if reason in ("revision_conflict", "stale_generation"):
                    self._attach.learn_revision(session_id, exc.data.get("revision"))
                    gen = exc.data.get("execution_generation")
                    if type(gen) is int and gen > self._attach.generation.get(session_id, -1):
                        self._attach.generation[session_id] = gen
                    continue
                if reason == "runtime_coordination_required" and not resumed:
                    resumed = True
                    await self.request("session.resume", {"session_id": session_id}, timeout=timeout)
                    continue
                raise
        assert last is not None
        raise last

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
