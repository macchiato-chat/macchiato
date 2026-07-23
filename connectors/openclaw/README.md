# Macchiato OpenClaw Connector

Bridges your local [OpenClaw](https://openclaw.ai) agent to [Macchiato](https://macchiato.chat) — chat with your agent from your phone or the web.

- **Mirror** — conversations your agent has on Discord / other channels appear in Macchiato live; full history import (archived sessions included, cron noise filtered)
- **Drive** — send from the app, replies stream back (busy turns get steered, not dropped)
- **Proactive push** — a bundled OpenClaw channel plugin (`plugin/`) lets your agent message you first
- **Per-session E2E** — opt-in end-to-end encryption with keys held by this connector and your devices
- **Self-healing** — health reporting, mirror watchdog, systemd auto-restart

## Install

Use the one-line installer from the repo root (auto-detects OpenClaw):

```bash
Open the Macchiato app or https://macchiato.chat and copy the versioned, SHA-256-verified install command.
```

### Manual

```bash
git clone https://github.com/macchiato-chat/macchiato
cd macchiato/connectors/openclaw
npm install
npm run pair      # one-time: shows a pairing code — enter it at macchiato.chat
npm start         # run (or install deploy/macchiato-openclaw-connector.service)
# optional, for proactive push:
openclaw plugins install --force ./plugin && openclaw plugins enable macchiato
```

Requires Node 22+, a running OpenClaw gateway (the connector reads its address + token from `~/.openclaw`), and a Macchiato account.

## Env

| Var | Default | |
|---|---|---|
| `MACCHIATO_SERVER_URL` | `wss://api.macchiato.chat/connector` | Macchiato server |
| `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` | from `~/.openclaw` | gateway override |
| `MACCHIATO_OPENCLAW_POLL_MS` | `5000` | mirror poll interval |

## Tests

```bash
npm test          # 57 tests: crypto vectors, mirror, drive, push, health
```

Notes: OpenClaw's gateway emits message-level (not token-level) events, so replies appear as complete messages; the "working…" indicator shows immediately. Session keys are lowercased by OpenClaw — handled internally.
