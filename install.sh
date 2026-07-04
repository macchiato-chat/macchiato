#!/usr/bin/env bash
# Macchiato Connector — one-line installer
#   curl -sSL https://raw.githubusercontent.com/macchiato-chat/macchiato/main/install.sh | bash
#
# Auto-detects which agent(s) you run — Hermes and/or OpenClaw — and installs the
# matching connector(s): download → pair (one-time code) → systemd user service.
#
# Env overrides:
#   MACCHIATO_SERVER_URL   (default wss://api.macchiato.chat/connector)
#   HERMES_PYTHON          (path to the python inside your Hermes venv, if auto-detect fails)
#   MACCHIATO_ONLY         ("hermes" | "openclaw" — skip auto-detect, install just one)

set -euo pipefail

REPO_TARBALL="https://github.com/macchiato-chat/macchiato/tarball/main"
UNIT_DIR="$HOME/.config/systemd/user"

say()  { printf '\033[1;35m[macchiato]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[macchiato]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[macchiato] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

have_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

install_unit() { # $1=unit-name $2=ExecStart $3=WorkingDirectory(optional)
  if ! have_systemd; then
    warn "No systemd here — keep this running yourself:  $2"
    return 0
  fi
  mkdir -p "$UNIT_DIR"
  {
    echo "[Unit]"
    echo "Description=Macchiato Connector ($1)"
    echo "After=network-online.target"
    echo
    echo "[Service]"
    [ -n "${3:-}" ] && echo "WorkingDirectory=$3"
    echo "ExecStart=$2"
    echo "Restart=always"
    echo "RestartSec=5"
    echo "Environment=PYTHONUNBUFFERED=1"
    [ -n "${MACCHIATO_SERVER_URL:-}" ] && echo "Environment=MACCHIATO_SERVER_URL=$MACCHIATO_SERVER_URL"
    echo
    echo "[Install]"
    echo "WantedBy=default.target"
  } > "$UNIT_DIR/$1.service"
  systemctl --user daemon-reload
  systemctl --user enable "$1.service"
  # restart (not just start) so re-running the installer to UPDATE actually loads the
  # freshly-downloaded code — an already-running service ignores `start`.
  systemctl --user restart "$1.service"
  say "Service $1 running ✓   Update anytime by re-running this installer. Logs: journalctl --user -u $1 -f"
}

# ── shared: download repo once ──────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "Downloading Macchiato connectors…"
curl -sSL "$REPO_TARBALL" | tar -xz -C "$TMP" --strip-components=1
[ -d "$TMP/connectors" ] || fail "Downloaded repo has no connectors/ (repo layout changed?)"

# ═════════════════════════════ Hermes ═══════════════════════════════════════
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
  local h target py
  h="$(command -v hermes 2>/dev/null || true)"
  if [ -n "$h" ] && [ -f "$h" ]; then
    target="$(sed -n 's/^exec "\{0,1\}\([^" ]*\)"\{0,1\}.*/\1/p' "$h" | head -1)"
    [ -z "$target" ] && target="$(sed -n '1s/^#!//p' "$h" | awk '{print $1}')"
    if [ -n "$target" ]; then
      py="$(dirname "$target")/python"
      [ -x "$py" ] && { echo "$py"; return; }
      case "$target" in *python*) [ -x "$target" ] && { echo "$target"; return; } ;; esac
    fi
  fi
  echo ""
}

install_hermes() {
  local PY APP="$HOME/.macchiato/app" CRED="$HOME/.macchiato/connector.json"
  PY="$(find_hermes_python)"
  [ -n "$PY" ] || fail "Hermes not found. Install it first (curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash), or set HERMES_PYTHON and re-run."
  "$PY" -c "import websockets" 2>/dev/null || fail "Hermes venv is missing websockets (required). Run: $PY -m pip install websockets"
  say "Hermes connector → $APP  (python: $PY)"
  mkdir -p "$APP"
  cp "$TMP"/connectors/hermes/*.py "$APP/"
  if [ ! -f "$CRED" ]; then
    say "Pairing Hermes connector (enter the code below at macchiato.chat)"
    "$PY" "$APP/pair.py" || fail "Pairing not completed. Re-run this script to continue."
  else
    say "Hermes credentials found, skipping pairing"
  fi
  install_unit "macchiato-connector" "$PY $APP/connector.py"
  # Platform plugin: lets Hermes proactively deliver to Macchiato (best effort)
  if [ -d "$TMP/connectors/hermes/plugin/macchiato" ]; then
    mkdir -p "$HOME/.hermes/plugins"
    cp -r "$TMP/connectors/hermes/plugin/macchiato" "$HOME/.hermes/plugins/"
    command -v hermes >/dev/null 2>&1 && hermes plugins enable macchiato >/dev/null 2>&1 || true
    say "Hermes 'macchiato' platform plugin installed — restart your Hermes gateway to load it"
  fi
}

# ═════════════════════════════ OpenClaw ═════════════════════════════════════
install_openclaw() {
  local APP="$HOME/.macchiato/openclaw-app" CRED="$HOME/.macchiato/openclaw-connector.json"
  command -v node >/dev/null 2>&1 || fail "node not found (OpenClaw requires Node — is OpenClaw actually installed?)"
  command -v npm >/dev/null 2>&1 || fail "npm not found"
  say "OpenClaw connector → $APP"
  mkdir -p "$APP"
  cp -r "$TMP"/connectors/openclaw/src "$TMP"/connectors/openclaw/plugin "$TMP"/connectors/openclaw/package.json "$TMP"/connectors/openclaw/tsconfig.json "$APP/"
  (cd "$APP" && npm install --omit=dev --silent) || fail "npm install failed in $APP"
  if [ ! -f "$CRED" ]; then
    say "Pairing OpenClaw connector (enter the code below at macchiato.chat)"
    (cd "$APP" && MACCHIATO_PAIR_ONLY=1 ./node_modules/.bin/tsx src/index.ts) || fail "Pairing not completed. Re-run this script to continue."
  else
    say "OpenClaw credentials found, skipping pairing"
  fi
  install_unit "macchiato-openclaw-connector" "$APP/node_modules/.bin/tsx src/index.ts" "$APP"
  # Channel plugin: lets OpenClaw proactively deliver to Macchiato (best effort)
  if command -v openclaw >/dev/null 2>&1; then
    if openclaw plugins install --force "$APP/plugin" >/dev/null 2>&1 && openclaw plugins enable macchiato >/dev/null 2>&1; then
      say "OpenClaw 'macchiato' channel plugin installed — restart your OpenClaw gateway to load it"
    else
      warn "Could not install the OpenClaw channel plugin automatically. Manually: openclaw plugins install --force $APP/plugin && openclaw plugins enable macchiato"
    fi
  fi
}

# ── detect + run ─────────────────────────────────────────────────────────────
ONLY="${MACCHIATO_ONLY:-}"
HAS_HERMES=0; HAS_OPENCLAW=0
[ -n "$(find_hermes_python)" ] && HAS_HERMES=1
{ command -v openclaw >/dev/null 2>&1 || [ -f "$HOME/.openclaw/openclaw.json" ]; } && HAS_OPENCLAW=1

case "$ONLY" in
  hermes)   install_hermes ;;
  openclaw) install_openclaw ;;
  "")
    [ "$HAS_HERMES" = 1 ] || [ "$HAS_OPENCLAW" = 1 ] || fail "No supported agent found (Hermes or OpenClaw). Install one first — see README."
    [ "$HAS_HERMES" = 1 ]   && install_hermes
    [ "$HAS_OPENCLAW" = 1 ] && install_openclaw
    ;;
  *) fail "MACCHIATO_ONLY must be 'hermes' or 'openclaw'" ;;
esac

say "Done! Open Macchiato — your conversations will start syncing."
