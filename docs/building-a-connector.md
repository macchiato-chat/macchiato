# Building a Macchiato connector

> **Audience:** you already run an AI agent that is **not** one of the four built-in ones
> (Hermes, OpenClaw, Claude Code, Codex), and you want it to show up in the Macchiato app.
>
> **Language:** English (this file ships to the [public repo](https://github.com/macchiato-chat/macchiato)).
>
> **Status:** living guide. Wire shapes evolve; when docs and code disagree, **trust the
> vendored protocol constants and the four reference connectors** in that repo.

---

## 1. Is this allowed?

**Yes.** Macchiato is built so *your* agent stays on *your* machine and dials out. Any
program that implements **Link B** can pair to a Macchiato account and drive/mirror chat
through the official cloud. You do **not** need special approval to write a personal or
open connector for your own agent.

What “allowed” means in practice:

| You may | You should not |
|---|---|
| Pair a custom connector to **your** account with a pairing code | Impersonate another user’s connector or scrape others’ tokens |
| Speak Link B against `wss://api.macchiato.chat/connector` | Open inbound ports or reverse-proxy unauthenticated agent traffic into the cloud |
| Fork the public connector sources as a starting point (read the [license](https://github.com/macchiato-chat/macchiato/blob/main/LICENSE.md)) | Redistribute Macchiato connectors as a **competing product** (PolyForm Shield) |
| Report any `kind` string (or none) | Expect first-class UI gates for unofficial kinds (see §7) |
| Keep agent API keys / OAuth on the machine | Upload subscription OAuth files to Macchiato servers or third parties |

Macchiato hosts the **chat app + multi-tenant cloud** (history, search, pairing, push).
It does **not** host your model, provider account, or agent process. The connector is the
only bridge.

---

## 2. Architecture in one picture

```
  phone / web  ──WSS Link A──▶  Macchiato cloud (api.macchiato.chat)
                                      │
                                      │  WSS Link B  (connector dials out)
                                      ▼
                               your connector  ──▶  your agent
                               (this machine)      (CLI / gateway / SDK)
```

- **No inbound ports** on the user machine. The connector opens a long-lived outbound
  WebSocket to the server.
- **Envelope:** every WS text frame is one JSON object with a `t` discriminant
  (`pair_request`, `hello`, `tui`, `connector_health`, …). Not NDJSON batches.
- **Payload of chat:** after auth, most traffic is `{ "t": "tui", "agentLinkId", "sessionId?", "frame" }`
  where `frame` is a **tui_gateway-shaped** JSON-RPC request or event
  (`prompt.submit`, `message.start` / `message.delta` / `message.complete`, …).

Official connectors in the public repo (best references, in roughly increasing complexity):

| Path | Language | Good for learning |
|---|---|---|
| [`connectors/openclaw/`](https://github.com/macchiato-chat/macchiato/tree/main/connectors/openclaw) | TypeScript | Link B client + pairing + health; gateway-style agent |
| [`connectors/codex/`](https://github.com/macchiato-chat/macchiato/tree/main/connectors/codex) | TypeScript | Drive turns + approvals + models |
| [`connectors/claude-code/`](https://github.com/macchiato-chat/macchiato/tree/main/connectors/claude-code) | TypeScript | Full agent-SDK bridge, tools, tasks |
| [`connectors/hermes/`](https://github.com/macchiato-chat/macchiato/tree/main/connectors/hermes) | Python | Original design; tui_gateway native |

Protocol version constants live in each TS connector as `src/linkb/proto.ts`
(`LINK_B_PROTO`, `CONNECTOR_VERSION`). **Always read those files for the numbers in force.**

---

## 3. Minimal path: pair → hello → one turn

You need three stages. Stages 1–2 are pure protocol; stage 3 is “your agent.”

### 3.1 Pairing (no credentials yet)

1. Open `wss://api.macchiato.chat/connector` (override with `MACCHIATO_SERVER_URL` if needed).
2. Send:

```json
{
  "t": "pair_request",
  "proto": 5,
  "label": "MyAgent (hostname)",
  "kind": "my-agent"
}
```

3. Server replies `{ "t": "pair_pending", "code": "……", "expiresAt": "…" }`.
4. Print the code. User signs in at [macchiato.chat](https://macchiato.chat) → **Pair connector** → enters the code.
5. Server replies once:

```json
{
  "t": "paired",
  "connectorToken": "<long-lived secret — shown only this once>",
  "agentLinkId": "<id>"
}
```

6. **Persist** `{ serverUrl, connectorToken, agentLinkId }` to a file owned by the user
   (`0600`, atomic write). Close the socket. Reconnect for stage 3.2.

Notes:

- `proto` must be in the server’s supported set (currently **3, 4, and 5**). New connectors
  should send the current `LINK_B_PROTO` from `proto.ts` (today **5**). Wrong proto →
  `auth_error` and close.
- Pairing codes expire (~minutes). Refresh by sending another `pair_request` on the same
  open socket before expiry.
- Optional QR payload for scanners: `{ "v": 1, "url": "https://api.macchiato.chat", "code": "<code>" }`
  (or the web origin your app uses for claim). Official connectors print an ANSI QR in the
  terminal (pure library — no system `qrencode` required).

### 3.2 Hello (credentials on disk)

1. Open the same `/connector` URL again.
2. Send:

```json
{
  "t": "hello",
  "connectorToken": "<from creds>",
  "agentLinkId": "<from creds>",
  "proto": 5
}
```

3. On success: `{ "t": "ready", … }`. You are online.
4. On failure: `{ "t": "auth_error", "reason": "…" }` then close. Treat
   `revoked` / invalid token as **terminal** — quarantine local creds and stop (or wait for
   re-pair). Do **not** spin forever with a dead token.

Capability flags on `hello` (all optional, only send what you implement, value must be `1`):

| Field | Meaning if `1` |
|---|---|
| `e2eFailClosed` | E2E backfill only after server ACK; honor `ready.e2eState` |
| `e2eControlAuth` | Verify signed E2E control envelopes |
| `mirrorDurable` | Durable mirror outbox + understand `mirror_nack.code` |
| `rewind` / `fork` | Session rewind / fork (requires agent support) |

**Do not declare a capability you cannot honor.** Missing fields = “old / no support” and
are always safe.

### 3.3 Drive one chat turn (MVP)

After `ready`, the server will send tui **requests** when the user chats. At minimum handle:

**Inbound (server → you), wrapped:**

```json
{
  "t": "tui",
  "agentLinkId": "<id>",
  "sessionId": "<macchiato session id>",
  "frame": {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "prompt.submit",
    "params": { "session_id": "<wire id>", "text": "Hello from the app" }
  }
}
```

Important:

- Outer `sessionId` is the Macchiato/wire session id (routing).
- Inside `params.session_id` is what tui_gateway historically used; **keep a map** between
  Macchiato session ids and your agent’s native session ids. For a greenfield agent you can
  use the same string both sides.

**Outbound (you → server)** for a simple text reply — emit events, not a single blob:

```json
{ "t": "tui", "agentLinkId": "<id>", "sessionId": "<same>",
  "frame": { "jsonrpc": "2.0", "method": "event",
    "params": { "type": "message.start", "session_id": "<same>" } } }

{ "t": "tui", "agentLinkId": "<id>", "sessionId": "<same>",
  "frame": { "jsonrpc": "2.0", "method": "event",
    "params": { "type": "message.delta", "session_id": "<same>",
      "payload": { "text": "Hi!" } } } }

{ "t": "tui", "agentLinkId": "<id>", "sessionId": "<same>",
  "frame": { "jsonrpc": "2.0", "method": "event",
    "params": { "type": "message.complete", "session_id": "<same>",
      "payload": { "text": "Hi!", "status": "complete", "usage": {} } } } }
```

Also answer JSON-RPC **results** for requests that carry an `id` (at least
`prompt.submit` → `{ "jsonrpc":"2.0", "id": <same>, "result": { "status": "streaming" } }`).

**Other inbound methods worth handling early:**

| Method | You should |
|---|---|
| `session.create` | Create a native session; map ids; optional title/cwd/model |
| `session.interrupt` | Stop the in-flight turn |
| `session.delete` / `session.archive` | Best-effort local cleanup |
| `approval.respond` | If you ever emit `approval.request` |

**Ping/pong:** either side may send `{ "t": "ping" }`; reply `{ "t": "pong" }`. Server also
sends WebSocket-level pings — stay responsive so half-open sockets die cleanly.

### 3.4 Health (highly recommended)

Every ~30s after `ready`:

```json
{
  "t": "connector_health",
  "agentLinkId": "<from creds>",
  "health": {
    "gatewayAlive": true,
    "compatOk": true,
    "mirrorLastPollAgeS": 0,
    "connectorVersion": "0.1.0",
    "kind": "my-agent",
    "stt": false
  }
}
```

- `agentLinkId` is **required** — the server routes health by it. Omitting it silently drops
  the report (the app keeps showing the connector as unknown/degraded).
- `gatewayAlive` / `compatOk` false → app shows **degraded**.
- `mirrorLastPollAgeS` > ~60 → treated as stuck mirror (use `0` if you have no mirror).
- `kind` is free-form on the wire; see §7 for what the server stores.

---

## 4. Tiny Node skeleton (copy-paste starting point)

This is intentionally incomplete (no agent, no reconnect storm control). It shows the
**wire order** only. Prefer forking `connectors/openclaw/src/linkb/` for production code.

```js
// pair-and-hello.mjs — Node 20+, `npm i ws`  (ESM: use import, not require)
import WebSocket from "ws";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const SERVER = process.env.MACCHIATO_SERVER_URL || "wss://api.macchiato.chat/connector";
const WEB = process.env.MACCHIATO_WEB_URL || "https://macchiato.chat";
const PROTO = 5; // keep in sync with public connectors/*/src/linkb/proto.ts LINK_B_PROTO
const CRED = process.env.MACCHIATO_CRED || join(homedir(), ".macchiato/my-agent-connector.json");

function saveCreds(c) {
  mkdirSync(join(homedir(), ".macchiato"), { recursive: true });
  const tmp = CRED + ".tmp";
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, CRED);
}

function loadCreds() {
  if (!existsSync(CRED)) return null;
  return JSON.parse(readFileSync(CRED, "utf8"));
}

function pair() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        t: "pair_request",
        proto: PROTO,
        label: `MyAgent (${hostname()})`,
        kind: "my-agent",
      }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === "pair_pending") {
        console.log(`\n>>>  ${msg.code}  <<<`);
        console.log(`Sign in at ${WEB} → Pair connector → enter this code.\n`);
      } else if (msg.t === "paired") {
        const creds = {
          serverUrl: SERVER,
          connectorToken: msg.connectorToken,
          agentLinkId: msg.agentLinkId,
        };
        saveCreds(creds);
        console.log("Paired. Credentials saved to", CRED);
        ws.close();
        resolve(creds);
      } else if (msg.t === "auth_error") {
        reject(new Error(msg.reason));
      }
    });
    ws.on("close", () => reject(new Error("socket closed before paired")));
  });
}

function run(creds) {
  const ws = new WebSocket(creds.serverUrl || SERVER);
  ws.on("open", () => {
    ws.send(JSON.stringify({
      t: "hello",
      connectorToken: creds.connectorToken,
      agentLinkId: creds.agentLinkId,
      proto: PROTO,
    }));
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t === "ready") {
      console.log("Link B ready");
      setInterval(() => {
        ws.send(JSON.stringify({
          t: "connector_health",
          agentLinkId: creds.agentLinkId,
          health: {
            gatewayAlive: true,
            compatOk: true,
            mirrorLastPollAgeS: 0,
            connectorVersion: "0.1.0",
            kind: "my-agent",
            stt: false,
          },
        }));
      }, 30_000);
      return;
    }
    if (msg.t === "ping") {
      ws.send(JSON.stringify({ t: "pong" }));
      return;
    }
    if (msg.t === "auth_error") {
      console.error("auth_error:", msg.reason);
      process.exit(78); // EX_CONFIG — stop supervisor restart loops on revoked
    }
    if (msg.t === "tui" && msg.frame?.method && msg.frame.method !== "event") {
      const { frame, sessionId, agentLinkId } = msg;
      // ACK request
      if (frame.id != null) {
        ws.send(JSON.stringify({
          t: "tui", agentLinkId, sessionId,
          frame: { jsonrpc: "2.0", id: frame.id, result: { status: "streaming" } },
        }));
      }
      if (frame.method === "prompt.submit") {
        const sid = frame.params?.session_id || sessionId;
        const text = `echo: ${frame.params?.text ?? ""}`;
        for (const type of ["message.start", "message.delta", "message.complete"]) {
          const payload =
            type === "message.start" ? undefined
            : type === "message.delta" ? { text }
            : { text, status: "complete", usage: {} };
          ws.send(JSON.stringify({
            t: "tui", agentLinkId, sessionId,
            frame: {
              jsonrpc: "2.0",
              method: "event",
              params: { type, session_id: sid, ...(payload ? { payload } : {}) },
            },
          }));
        }
      }
      // TODO: session.create / session.interrupt / wire your real agent here
    }
  });
}

const existing = loadCreds();
if (existing?.connectorToken) run(existing);
else pair().then(run).catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Run: `node pair-and-hello.mjs` → enter the printed code in the app → send a message to the
new agent → you should see `echo: …` stream back.

---

## 5. What to implement next (priority order)

MVP above is enough to **chat**. Real agents almost always want more, in this order:

1. **Session lifecycle** — `session.create` / map ids / resume after reconnect.
2. **Interrupt** — `session.interrupt` cancels the running turn; `message.complete` with
   `status: "interrupted"`.
3. **Streaming** — many small `message.delta` frames (token or chunk level).
4. **Tools** — `tool.start` → `tool.complete` (with `tool_id`, `name`, `args`, `result`).
5. **Approvals** — emit `approval.request`, wait for `approval.respond`, then continue.
6. **Titles** — emit session title updates when you have a good name (local first-message
   truncation is fine; never hardcode a cloud model — see §8).
7. **Mirror** (optional) — if the agent chats elsewhere (Discord, terminal UI), tail that
   store and send `mirror_append` batches with stable `srcId` per message for dedup.
8. **Import** — `import_available` / `import_start` / `import_batch` for first-time history.
9. **Attachments** — download `prompt.submit.attachments[].url` (SSRF-safe: no link-local,
   pin DNS, size cap) and inject into the agent; optional `media.attach` outbound.
10. **E2E** — only if you need encrypted sessions; study `e2e/` in the TS connectors and
    implement capability flags honestly.
11. **Self-update** — only if you distribute a packaged connector; official path uses signed
    manifests (see public install pipeline). Personal scripts can skip this.

---

## 6. Local debugging

| Goal | Approach |
|---|---|
| Pair against production | Default URL; use a throwaway Macchiato account while developing |
| Inspect frames | Log every inbound/outbound JSON (redact `connectorToken`) |
| Re-pair cleanly | Delete `~/.macchiato/*-connector.json` (and `.revoked` if present), restart |
| Protocol numbers | Read `connectors/*/src/linkb/proto.ts` on the public tag you target |
| Compare behaviour | Run an official connector with `MACCHIATO_SERVER_URL` pointed the same place |
| Unit-test your bridge | Mock the WS; feed recorded `prompt.submit` frames; assert emitted events |

**Do not** point automated tests at production with real user OAuth subscriptions for the
*agent* CLI. Keep agent auth as the user’s normal local login; your tests should use API
keys in a sandbox home if they spawn real CLIs.

Staging / private monorepo tooling exists for Macchiato maintainers only; external
developers should treat **production Link B + a test account** as the integration surface.

---

## 7. `kind` and the UI

Server accepts any connector. Official **stored** kinds are currently:

```
hermes | openclaw | claude-code | codex
```

If you send something else (e.g. `"my-agent"`) or omit `kind`:

- The WebSocket stays up.
- `agent_links.kind` may be stored as **null** (unknown values are sanitized).
- App features gated on official kinds (certain project UIs, remote OAuth helpers, …)
  stay **off**. Generic chat still works.

You can still set `label` to a clear human name (`Aider on studio-mac`). Health may include
the same free-form `kind` for your own logs; clients only trust the sanitized value.

When/if an unofficial connector becomes popular, maintainers can add it to the whitelist
and ship UI labels — that is a product change, not a protocol break.

---

## 8. Never hardcode provider or model

Connectors that call an LLM for **titles, summaries, or helper text** must use **whatever
provider/model the user’s agent is already configured to use** (route through the agent, or
read its config). Never embed:

- a fixed OpenRouter / Anthropic / OpenAI model id as “the” default, or
- an API key that is not the user’s.

Subscription agents often have **no raw API key** (OAuth only). A hardcoded cloud model
will fail for most public users even if it works on your laptop.

Safe fallback when generation fails: truncate the first user message for the session title.

---

## 9. Security checklist

- [ ] Credentials file mode `0600`, written via temp + rename.
- [ ] Log redaction: never print `connectorToken` after the `paired` line.
- [ ] On `auth_error` with revoke/invalid token: quarantine creds, exit non-zero (e.g. 78)
      so process supervisors do not hammer the server.
- [ ] Attachment downloads: allowlist schemes (`https:`), block private IP ranges after DNS
      resolve, pin the IP you validated, refuse weird redirects, enforce size limits.
- [ ] Outbound media: only read files under agent-approved roots; never follow `MEDIA:` into
      `$HOME/.ssh` or env files.
- [ ] No OAuth credential files copied into test harnesses or CI artifacts.
- [ ] Treat Link B as authenticated but **not** a substitute for agent-side sandboxing —
      the server is not your security boundary for shell tools.

---

## 10. Protocol compatibility

- **Link B `proto`:** send current `LINK_B_PROTO`. Server accepts a **set** of versions so
  older connectors can still connect and self-update. Do not hardcode an ancient number from
  a blog post.
- **Additive fields:** optional JSON fields are the normal extension mode. Old servers
  ignore unknown `t` values and extra keys. Prefer new optional fields over breaking bumps.
- **Hard bumps** of `LINK_B_PROTO` are rare and coordinated (server first, then connectors).
- Track changes by reading release notes / `proto.ts` on each public release tag.

---

## 11. Shipping your connector

1. Keep it **next to the agent** (same machine/user as the agent’s files).
2. Document env vars (`MACCHIATO_SERVER_URL`, credential path, agent binary path).
3. Provide a user-level service unit (systemd / launchd) with restart-on-failure and
   `RestartPreventExitStatus=` for permanent auth failures if you use that pattern.
4. If you open-source it, **do not** claim it is an official Macchiato connector unless it
   is merged into [macchiato-chat/macchiato](https://github.com/macchiato-chat/macchiato).
5. Issues for the **cloud / protocol**: public tracker on that repo. Agent-specific bugs:
   your own tracker.

Official install (`curl … install.sh`) only manages the four built-in connectors. Custom
connectors are installed and updated by **you**.

---

## 12. FAQ

**Can I use Macchiato as a generic remote UI for any bot?**  
Yes, if you implement Link B. Quality depends on how faithfully you map streaming, tools,
and approvals.

**Do I need to open a PR to Macchiato?**  
No for personal use. A PR is only needed if you want first-class install, `kind` whitelist,
and UI labels.

**Is the private monorepo protocol package public?**  
The public repo vendors a slim `proto.ts` into each TS connector. That is the external
source of truth for version numbers. Full TypeScript protocol types live in the private
monorepo and power the server/app.

**Where is the exact field list for every message?**  
In the reference connectors’ handlers and `proto.ts`. This guide intentionally does **not**
duplicate every optional field — those tables go stale. Copy patterns from OpenClaw/Codex.

**Can I talk to staging?**  
External developers: use production + a test account. Maintainer staging is internal.

---

## 13. Related reading (in this / public tree)

| Doc / path | Why |
|---|---|
| Public `connectors/*/README.md` | Install and env knobs per official agent |
| Public `connectors/*/src/linkb/` | Pairing, creds, reconnect, frame dispatch |
| Public `connectors/*/src/linkb/proto.ts` | `LINK_B_PROTO` / `CONNECTOR_VERSION` |
| Private monorepo `docs/link-b-contract.md` | Maintainer-oriented Link B primer |
| Private monorepo `docs/connector-kind-policy.md` | Why kinds are whitelisted on the server |
| Private monorepo `packages/protocol/` | Full TS protocol (maintainers) |

---

*Questions or corrections:* open an issue on
[macchiato-chat/macchiato](https://github.com/macchiato-chat/macchiato/issues)
with the title prefix `[connector-dev]`.
