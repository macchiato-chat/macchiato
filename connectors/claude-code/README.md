# Macchiato Claude Code Connector

Bridges your local [Claude Code](https://claude.com/claude-code) to Macchiato: full conversation
mirroring (reads `~/.claude/projects` transcripts), remote-driven turns via the official
Claude Agent SDK, tool-approval cards, background-task display/stop, mid-turn steering,
native image input, and automatic session titles.

## Install (one-liner, from the repo root README)

```
curl -sSL https://raw.githubusercontent.com/macchiato-chat/macchiato/main/install.sh | MACCHIATO_ONLY=claude-code bash
```

Requires: the `claude` CLI (2.1.x+) logged in on this machine, plus Node 20+.

## Env knobs

| var | default | meaning |
|---|---|---|
| `MACCHIATO_SERVER_URL` | `wss://api.macchiato.chat/connector` | server |
| `MACCHIATO_CLAUDE_BIN` | auto-probe | absolute path to the `claude` CLI |
| `MACCHIATO_CC_WORKDIR` | `$HOME` | default working directory for new sessions |
| `MACCHIATO_CC_PERMISSION_MODE` | (ask) | `bypassPermissions` / `acceptEdits` / … |
| `MACCHIATO_CC_IDLE_S` | `600` | idle seconds before the per-session CLI process is recycled (resume is seamless) |
| `MACCHIATO_CC_TITLE_MODE` | `summary` | `summary` / `firstmsg` / `off` |

Run tests: `npm install && npm test`.
