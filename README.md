<div align="center">

# Macchiato ☕

**Chat with _your own_ AI agent — from anywhere.**

Your agent lives on your hardware. Macchiato puts it in your pocket.

[Website](https://macchiato.chat) · [Install](#quick-start) · [How it works](#how-it-works) · [FAQ](#faq)

[![Latest release](https://img.shields.io/github/v/release/macchiato-chat/macchiato?label=release&color=6f4e37)](https://github.com/macchiato-chat/macchiato/releases)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-6f4e37)](#quick-start)
[![License](https://img.shields.io/badge/license-PolyForm%20Shield%201.0.0-6f4e37)](LICENSE.md)
[![Source available](https://img.shields.io/badge/source-available-6f4e37)](#license)

<br>

<!-- Hero image. Add a screenshot or short GIF of the app at docs/hero.png,
     then uncomment the line below:
<img src="docs/hero.png" alt="Macchiato on iOS and the web" width="820">
-->


</div>

---

The AI agent you already run — on a Raspberry Pi, a home server, a laptop — keeps living exactly where it is. Macchiato gives it a beautiful front door: a polished chat app on your **phone** and on the **web**, reachable from anywhere. The agent, its memory, and its API keys never leave your machine; a small connector you run beside it is the only bridge.

## Features

- 📱 **A real app, not a terminal** — native iOS and web clients with chat, voice input, and push notifications.
- 🔄 **One timeline for everything** — conversations your agent has *elsewhere* (Discord, Telegram, cron jobs) mirror into the app live, so nothing lives in a silo.
- 🔔 **Your agent messages you** — scheduled reports, "the long job finished," reminders — pushed to your phone, proactively.
- 🔒 **Nothing to open up** — a single outbound WebSocket over TLS. No inbound ports, no port-forwarding, no keys in the cloud.
- 🔑 **End-to-end encryption** — opt in per session; the keys live only on the connector and your own devices.
- 🔎 **Source-available** — it runs next to your data, so you can read exactly what it does.

## Supported agents

One line installs and pairs any of these. Run several at once — each shows up as its own agent in the app.

| Agent | Notes |
|---|---|
| **[Hermes](https://github.com/NousResearch)** | multi-profile; platform plugin for proactive push |
| **[OpenClaw](https://openclaw.ai)** | channel plugin included |
| **[Claude Code](https://claude.com/claude-code)** | |
| **[Codex](https://developers.openai.com/codex)** | |

## Quick start

On the machine where your agent runs:

```bash
curl -fsSL https://macchiato.chat/install.sh | bash
```

Then, in about a minute:

1. **Detect** — it finds your agent(s) automatically.
2. **Pair** — it prints a code; enter it at [macchiato.chat](https://macchiato.chat) to claim the connector.
3. **Done** — it installs a background service (Linux `systemd`, macOS launchd) so your agent stays reachable 24/7, and drops in the agent-side plugin for proactive push.

**Updating:** re-run the same line. It pulls the latest connector, keeps your pairing, and restarts the service — no re-pairing.

> The one-liner is verified end to end: a version-pinned bootstrap checked by SHA-256, which then verifies an Ed25519-signed release manifest and every file hash before anything runs.
>
> **Requirements:** a working [Hermes](https://github.com/NousResearch), [OpenClaw](https://openclaw.ai), [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex), and a free [Macchiato account](https://macchiato.chat).

## How it works

```
your phone / web  ⇄  Macchiato cloud  ⇄  connector  ⇄  your agent
                                        (this repo)    (your box, your keys)

                    └── one outbound WebSocket, TLS · no inbound ports ──┘
```

- **Drive** — prompts you send from the app reach your agent; replies stream back token by token.
- **Mirror** — the connector tails your agent's local session store and mirrors *other* channels into the app, ~2 s latency.
- **Push** — your agent sends you messages on its own, via its Macchiato plugin.
- **E2E** — opt-in per-session encryption; see `connectors/hermes/e2e_crypto.py`.

This repository distributes the connector plus its documentation and issue tracker.

## Advanced

<details>
<summary><b>Choosing connectors</b> (running more than one agent)</summary>

<br>

With a terminal attached, the installer shows an interactive picker (↑/↓ to move, space to tick, enter to confirm). To pick non-interactively — or in CI/containers — pass a list:

```bash
# only these two, no prompt (aliases: cc → claude-code, oc → openclaw)
curl -sSL https://macchiato.chat/install.sh | bash -s -- --agents=claude-code,codex
# everything detected, no prompt
curl -sSL https://macchiato.chat/install.sh | bash -s -- --yes
```

With no `--agents` and no terminal to prompt, it installs **every** detected connector. Run with `--help` to see all flags.
</details>

<details>
<summary><b>Multiple Hermes agents (profiles)</b></summary>

<br>

If you run [Hermes profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/) (`hermes profile create coder`), the installer detects them and lists each as its own row — `Hermes: coder` — in the picker. Each profile gets its own connector instance with its own pairing, so it shows up as a **separate agent** in the app (proactive delivery included — the plugin is installed per profile). Non-interactively: `--agents=hermes:coder`. Updating any instance updates just that one.
</details>

<details>
<summary><b>Turning off mirroring</b></summary>

<br>

By default the connector mirrors terminal-side agent sessions into the app. To keep the app to *only* the sessions you start from it, answer `n` at the installer's mirror prompt, or pass `--no-mirror` (env: `MACCHIATO_MIRROR=off`). Sessions you drive from the app work the same either way; you only lose the terminal "busy" indicator and automatic history import. Re-run the installer with `--mirror` / `--no-mirror` anytime to flip it.
</details>

<details>
<summary><b>Platforms & Hermes install methods</b></summary>

<br>

- **Linux** (incl. Raspberry Pi, WSL2) — fully supported; `systemd` service installed automatically.
- **macOS** — fully supported; launchd LaunchAgent installed automatically (logs: `~/.macchiato/logs/`).
- **Windows (native)** — not supported yet; run Hermes + connector under **WSL2**.
- Hermes installed via the **official one-liner, pipx, pip, or uv** is auto-detected (any layout where `hermes` is on PATH works). Exotic setups: set `HERMES_PYTHON=<path to your Hermes venv's python>`.

> Headless box? Run `loginctl enable-linger $USER` once so the service starts at boot without a login.
</details>

<details>
<summary><b>Manual install & env vars</b></summary>

<br>

```bash
git clone https://github.com/macchiato-chat/macchiato
cd macchiato/connectors/hermes
# use the python inside your Hermes venv:
PY=~/.local/share/pipx/venvs/hermes-agent/bin/python
$PY pair.py          # one-time pairing
$PY connector.py     # run (put it under systemd/tmux yourself)
```

Useful env vars: `MACCHIATO_SERVER_URL`, `MACCHIATO_CRED` (credential file path), `MACCHIATO_MIRROR_POLL_S` (mirror poll seconds).
</details>

<details>
<summary><b>Running the tests</b></summary>

<br>

```bash
cd connectors/hermes
~/.local/share/pipx/venvs/hermes-agent/bin/python -m unittest discover -s tests
```
</details>

## FAQ

**Is this open source?**
No — it's **source-available** under [PolyForm Shield 1.0.0](LICENSE.md). Read the code, run it, use it commercially; you just may not redistribute it as, or build it into, a competing product.

**Why can I read the source?**
Because this daemon sits next to your agent and your data. You shouldn't have to take our word for what it does — read it.

**pip / PyPI?**
Not yet — the installer pulls straight from this repository. A `pip install` package may come later.

**Where do I report bugs?**
[Issues](https://github.com/macchiato-chat/macchiato/issues) on this repo.

## License

**Source-available**, not open source — [PolyForm Shield 1.0.0](LICENSE.md). You can read it (audit what runs on your box), run it, and use it freely including commercially; you may not repackage it as a competing product.

---

<div align="center">

© Brian Sun · [macchiato.chat](https://macchiato.chat)
<br>
<sub>not open source, but yours to read</sub>

</div>
