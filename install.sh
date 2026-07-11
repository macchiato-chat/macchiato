#!/usr/bin/env bash
# Macchiato Connector — one-line installer
#   curl -sSL https://raw.githubusercontent.com/macchiato-chat/macchiato/main/install.sh | bash
#
# Auto-detects which agent(s) you run — Hermes, OpenClaw and/or Claude Code — and installs
# the matching connector(s): download → pair (one-time code) → systemd user service.
#
# Env overrides:
#   MACCHIATO_SERVER_URL   (default wss://api.macchiato.chat/connector)
#   HERMES_PYTHON          (path to the python inside your Hermes venv, if auto-detect fails)
#   MACCHIATO_CLAUDE_BIN   (absolute path to the claude CLI, if auto-detect fails)
#   MACCHIATO_ONLY         ("hermes" | "openclaw" | "claude-code" — skip auto-detect, install just one)
#   MACCHIATO_MANIFEST     (path to a pre-verified release.json — self_update passes it;
#                           every installed file is sha256-checked against it before use)

set -euo pipefail

REPO_TARBALL="https://github.com/macchiato-chat/macchiato/tarball/main"
UNIT_DIR="$HOME/.config/systemd/user"

say()  { printf '\033[1;35m[macchiato]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[macchiato]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[macchiato] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

have_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

# ── supply-chain check (#1): when MACCHIATO_MANIFEST is set (signed release.json already
# verified by the connector), every file we are about to install must hash-match it. ──
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
verify_tree() { # $1=dir under $TMP  $2=repo-relative prefix (e.g. connectors/hermes)
  [ -z "${MACCHIATO_MANIFEST:-}" ] && return 0
  local f rel want got n=0
  while IFS= read -r -d '' f; do
    rel="$2/${f#"$1"/}"
    # release.json is generated with a fixed one-line-per-file format — grep is reliable here
    want="$(grep -F "\"$rel\":" "$MACCHIATO_MANIFEST" | grep -oE '[0-9a-f]{64}' | head -1)"
    [ -n "$want" ] || fail "release.json has no entry for $rel — refusing to install unlisted files"
    got="$(sha256_of "$f")"
    [ "$got" = "$want" ] || fail "sha256 mismatch for $rel (manifest $want ≠ downloaded $got) — aborting"
    n=$((n+1))
  done < <(find "$1" -type f -print0)
  say "Manifest check ✓ $2 ($n files)"
}

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
    if [ -n "${MACCHIATO_UNIT_EXTRA_ENV:-}" ]; then
      while IFS= read -r kv; do [ -n "$kv" ] && echo "Environment=$kv"; done <<< "$MACCHIATO_UNIT_EXTRA_ENV"
    fi
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
curl -sSL --fail --proto '=https' "$REPO_TARBALL" | tar -xz -C "$TMP" --strip-components=1
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
  verify_tree "$TMP/connectors/hermes" "connectors/hermes"
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
  verify_tree "$TMP/connectors/openclaw" "connectors/openclaw"
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

# ═════════════════════════════ Claude Code ══════════════════════════════════
find_claude_bin() {
  if [ -n "${MACCHIATO_CLAUDE_BIN:-}" ]; then echo "$MACCHIATO_CLAUDE_BIN"; return; fi
  local cand
  cand="$(command -v claude 2>/dev/null || true)"
  [ -n "$cand" ] && { echo "$cand"; return; }
  for cand in "$HOME/.local/bin/claude" /usr/local/bin/claude /opt/homebrew/bin/claude; do
    [ -x "$cand" ] && { echo "$cand"; return; }
  done
  echo ""
}

install_claude_code() {
  local APP="$HOME/.macchiato/claude-code-app" CRED="$HOME/.macchiato/claude-code-connector.json" CLAUDE
  CLAUDE="$(find_claude_bin)"
  [ -n "$CLAUDE" ] || fail "Claude Code CLI not found. Install it first (https://claude.com/claude-code), or set MACCHIATO_CLAUDE_BIN and re-run."
  command -v node >/dev/null 2>&1 || fail "node not found (the Claude Code connector requires Node 20+)"
  command -v npm >/dev/null 2>&1 || fail "npm not found"
  say "Claude Code connector → $APP  (claude: $CLAUDE)"
  verify_tree "$TMP/connectors/claude-code" "connectors/claude-code"
  mkdir -p "$APP"
  cp -r "$TMP"/connectors/claude-code/src "$TMP"/connectors/claude-code/package.json "$TMP"/connectors/claude-code/tsconfig.json "$APP/"
  (cd "$APP" && npm install --omit=dev --silent) || fail "npm install failed in $APP"
  if [ ! -f "$CRED" ]; then
    say "Pairing Claude Code connector (enter the code below at macchiato.chat)"
    (cd "$APP" && MACCHIATO_PAIR_ONLY=1 MACCHIATO_CLAUDE_BIN="$CLAUDE" ./node_modules/.bin/tsx src/index.ts) || fail "Pairing not completed. Re-run this script to continue."
  else
    say "Claude Code credentials found, skipping pairing"
  fi
  # PATH: user systemd units often miss ~/.local/bin → the connector could not find the claude CLI.
  MACCHIATO_UNIT_EXTRA_ENV="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
MACCHIATO_CLAUDE_BIN=$CLAUDE"     install_unit "macchiato-claude-code-connector" "$APP/node_modules/.bin/tsx src/index.ts" "$APP"
}

# ── detect + run ─────────────────────────────────────────────────────────────
ONLY="${MACCHIATO_ONLY:-}"
HAS_HERMES=0; HAS_OPENCLAW=0; HAS_CLAUDE=0
[ -n "$(find_hermes_python)" ] && HAS_HERMES=1
{ command -v openclaw >/dev/null 2>&1 || [ -f "$HOME/.openclaw/openclaw.json" ]; } && HAS_OPENCLAW=1
[ -n "$(find_claude_bin)" ] && HAS_CLAUDE=1

case "$ONLY" in
  hermes)      install_hermes ;;
  openclaw)    install_openclaw ;;
  claude-code) install_claude_code ;;
  "")
    [ "$HAS_HERMES" = 1 ] || [ "$HAS_OPENCLAW" = 1 ] || [ "$HAS_CLAUDE" = 1 ] || fail "No supported agent found (Hermes, OpenClaw or Claude Code). Install one first — see README."
    [ "$HAS_HERMES" = 1 ]   && install_hermes
    [ "$HAS_OPENCLAW" = 1 ] && install_openclaw
    [ "$HAS_CLAUDE" = 1 ]   && install_claude_code
    ;;
  *) fail "MACCHIATO_ONLY must be 'hermes', 'openclaw' or 'claude-code'" ;;
esac

say "Done! Open Macchiato — your conversations will start syncing."
