# Macchiato ☕

**Chat with *your own* AI agent — from anywhere.**

🌐 **[macchiato.chat](https://macchiato.chat)**

Macchiato connects the AI agent running on **your** hardware (a Raspberry Pi, a home server, a laptop) to a polished chat app on your phone and on the web. Your agent keeps living where it always has — Macchiato gives it a beautiful front door.

- 📱 **iOS + Web** — chat, voice input, push notifications
- 🔄 **Full mirror** — conversations your agent has on Discord / Telegram / cron jobs show up here too, live
- 🤖 **Agent-first** — built for [Hermes](https://github.com/NousResearch) today; OpenClaw connector coming next
- 🔒 **Your keys, your box** — the agent, its memory, and its API keys never leave your machine; this connector is the only bridge

This repository distributes the **connector** — the small service you run next to your agent — plus its documentation and issue tracker.

---

## Install (Hermes)

On the machine where Hermes runs:

```bash
curl -sSL https://raw.githubusercontent.com/macchiato-chat/macchiato/main/install.sh | bash
```

The installer will:

1. find your Hermes install (the connector runs on Hermes' own Python),
2. download the connector to `~/.macchiato/app/`,
3. show a **pairing code** — enter it at [macchiato.chat](https://macchiato.chat) to claim this connector,
4. install a `systemd` user service so it runs 24/7.

**Requirements:** Linux with systemd (Raspberry Pi OS, Debian, Ubuntu…), a working [Hermes](https://github.com/NousResearch) install (pipx), and a Macchiato account.

> Headless box? Run `loginctl enable-linger $USER` once so the service starts at boot without a login.

### 中文安裝說明

在跑 Hermes 的那台機器上執行上面的一行命令。腳本會自動找到 Hermes、下載連接器、顯示**配對碼**（在 [macchiato.chat](https://macchiato.chat) 登錄後輸入認領）、並裝成 systemd 常駐服務。日誌：`journalctl --user -u macchiato-connector -f`。

### Manual install

```bash
git clone https://github.com/macchiato-chat/macchiato
cd macchiato/connectors/hermes
# use the python inside your Hermes venv:
PY=~/.local/share/pipx/venvs/hermes-agent/bin/python
$PY pair.py          # one-time pairing
$PY connector.py     # run (put it under systemd/tmux yourself)
```

Useful env vars: `MACCHIATO_SERVER_URL`, `MACCHIATO_CRED` (credential file path), `MACCHIATO_MIRROR_POLL_S` (mirror poll seconds).

---

## What the connector does

```
Hermes (your box, your keys)  ←→  connector (this repo)  ←→  Macchiato cloud  ←→  your phone
```

- **Drive** — prompts you send from the app are submitted to Hermes; replies stream back token by token.
- **Mirror** — it tails Hermes' local session store and mirrors conversations from *other* channels (Discord, Telegram, cron reports) into the app, ~2 s latency.
- **Push** — Hermes can proactively message you (scheduled reports, reminders) via its Macchiato platform plugin.
- **E2E (opt-in)** — individual sessions can be end-to-end encrypted with per-session keys held by the connector and your devices; see `connectors/hermes/e2e_crypto.py`.

The connector talks to the cloud over a single outbound WebSocket (TLS). No inbound ports, no port-forwarding.

## Running the tests

```bash
cd connectors/hermes
~/.local/share/pipx/venvs/hermes-agent/bin/python -m unittest discover -s tests
```

## FAQ

**Is this open source?**
No — this is **source-available** under the [PolyForm Shield 1.0.0](LICENSE.md) license. You can read the code (audit what runs on your box) and use it freely — including commercially — but you may not redistribute it as, or build it into, a competing product.

**Why can I read the source?**
Because this daemon sits next to your agent and your data. You shouldn't have to take our word for what it does — read it.

**pip / PyPI?**
Not yet — the installer pulls straight from this repository. A `pip install` package may come later.

**Where do I report bugs?**
[Issues](https://github.com/macchiato-chat/macchiato/issues) on this repo.

---

© Brian Sun · [macchiato.chat](https://macchiato.chat) · [PolyForm Shield 1.0.0](LICENSE.md) · not open source, but yours to read
