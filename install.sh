#!/usr/bin/env bash
# Macchiato Hermes Connector — one-line installer
#   curl -sSL https://raw.githubusercontent.com/macchiato-chat/macchiato/main/install.sh | bash
#
# What it does:
#   1. finds your Hermes install (the connector runs on Hermes' own Python venv)
#   2. downloads the connector to ~/.macchiato/app/
#   3. pairs this machine with your Macchiato account (one-time code)
#   4. installs + starts a systemd user service so it runs 24/7
#
# Env overrides:
#   MACCHIATO_SERVER_URL   (default wss://api.macchiato.chat/connector)
#   HERMES_PYTHON          (path to the python inside your Hermes venv, if auto-detect fails)

set -euo pipefail

REPO_TARBALL="https://github.com/macchiato-chat/macchiato/tarball/main"
APP_DIR="$HOME/.macchiato/app"
CRED="$HOME/.macchiato/connector.json"
UNIT_NAME="macchiato-connector.service"
UNIT_DIR="$HOME/.config/systemd/user"

say()  { printf '\033[1;35m[macchiato]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[macchiato] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. locate Hermes python ────────────────────────────────────────────────
# 順序：env 覆蓋 → 官方 one-liner 佈局 → pipx 佈局 → 從 PATH 上的 `hermes` 入口反解 venv。
find_hermes_python() {
  if [ -n "${HERMES_PYTHON:-}" ]; then echo "$HERMES_PYTHON"; return; fi
  local cand
  for cand in \
    /usr/local/lib/hermes-agent/venv/bin/python \
    "$HOME/.local/lib/hermes-agent/venv/bin/python" \
    "$HOME/.local/share/pipx/venvs/hermes-agent/bin/python" \
    "$HOME/.local/pipx/venvs/hermes-agent/bin/python"; do
    [ -x "$cand" ] && { echo "$cand"; return; }
  done
  # 通用：`hermes` 在 PATH 上 → 可能是 bash wrapper（exec ".../venv/bin/hermes"）或 python console-script
  local h target py
  h="$(command -v hermes 2>/dev/null || true)"
  if [ -n "$h" ] && [ -f "$h" ]; then
    target="$(sed -n 's/^exec "\{0,1\}\([^" ]*\)"\{0,1\}.*/\1/p' "$h" | head -1)"   # bash wrapper 的 exec 目標
    [ -z "$target" ] && target="$(sed -n '1s/^#!//p' "$h" | awk '{print $1}')"      # console-script 的 shebang
    if [ -n "$target" ]; then
      py="$(dirname "$target")/python"
      [ -x "$py" ] && { echo "$py"; return; }
      case "$target" in *python*) [ -x "$target" ] && { echo "$target"; return; } ;; esac
    fi
  fi
  echo ""
}

PY="$(find_hermes_python)"
[ -n "$PY" ] || fail "Hermes not found. Install it first (curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash), or set HERMES_PYTHON=<path to your Hermes venv python> and re-run."
"$PY" -c "import websockets" 2>/dev/null || fail "Hermes venv is missing websockets (required). Run: $PY -m pip install websockets"
say "Hermes Python: $PY"

# ── 2. download connector ──────────────────────────────────────────────────
say "Downloading connector → $APP_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sSL "$REPO_TARBALL" | tar -xz -C "$TMP" --strip-components=1
[ -d "$TMP/connectors/hermes" ] || fail "Downloaded repo has no connectors/hermes (repo layout changed?)"
mkdir -p "$APP_DIR"
cp "$TMP"/connectors/hermes/*.py "$APP_DIR/"

# ── 3. pair (first time only) ──────────────────────────────────────────────
if [ ! -f "$CRED" ]; then
  say "First install: pairing (enter the code below at macchiato.chat)"
  "$PY" "$APP_DIR/pair.py" || fail "Pairing not completed. Re-run this script to continue."
else
  say "Credentials found ($CRED), skipping pairing"
fi

# ── 4. systemd user service ────────────────────────────────────────────────
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$UNIT_NAME" <<UNIT
[Unit]
Description=Macchiato Hermes Connector
After=network-online.target

[Service]
ExecStart=$PY $APP_DIR/connector.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
${MACCHIATO_SERVER_URL:+Environment=MACCHIATO_SERVER_URL=$MACCHIATO_SERVER_URL}

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"
  # Headless box? Run: loginctl enable-linger $USER (start at boot without login)
  say "Service started ✓   Logs: journalctl --user -u $UNIT_NAME -f"
else
  say "No systemd here — keep this running yourself:  $PY $APP_DIR/connector.py"
fi

say "Done! Open Macchiato — your conversations will start syncing."
