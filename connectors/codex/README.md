# Macchiato Codex Connector

Bridges your local [Codex CLI](https://developers.openai.com/codex) to Macchiato: conversation
mirroring (tails `~/.codex/sessions` rollout logs), remote-driven turns via `codex exec` (with
`resume` for follow-ups), automatic session titles (via your own Codex), token/cost reporting,
and compat self-checks. Runs on your ChatGPT subscription or API key — the connector never
hardcodes a provider.

## Install (one-liner)

```
curl -sSL https://raw.githubusercontent.com/macchiato-chat/macchiato/main/install.sh | MACCHIATO_ONLY=codex bash
```

Requires: the `codex` CLI (0.140+) logged in on this machine (`codex login`), plus Node 20+.

## Env knobs

| var | default | meaning |
|---|---|---|
| `MACCHIATO_SERVER_URL` | `wss://api.macchiato.chat/connector` | server |
| `MACCHIATO_CODEX_BIN` | auto-probe | absolute path to the `codex` CLI |
| `MACCHIATO_CODEX_WORKDIR` | `$HOME` | default working directory for new sessions |
| `MACCHIATO_CODEX_SANDBOX` | `workspace-write` | `read-only` / `workspace-write` / `danger-full-access` |
| `MACCHIATO_CODEX_TITLE_MODE` | `summary` | `summary` / `firstmsg` / `off` |

Run tests: `npm install && npm test`.

## v1 scope

Mirror + drive (per-turn `codex exec`, item-level streaming) + titles + usage. Not yet: token-level
delta streaming, remote tool approval, mid-turn steer, native image input — these require the
experimental `app-server` face and land in v2.
