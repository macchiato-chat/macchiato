#!/usr/bin/env bash
# Macchiato Connector — one-line installer
#   curl -sSL https://raw.githubusercontent.com/macchiato-chat/macchiato/main/install.sh | bash
#
# Detects which agent(s) you run — Hermes, OpenClaw, Claude Code and/or Codex — and installs
# the matching connector(s): download → pair (one-time code) → background service
# (Linux: systemd user service; macOS: launchd LaunchAgent).
#
# Choosing what to install (when you run more than one agent):
#   • Pass a list:   … | bash -s -- --agents=claude-code,codex
#   • Or just run it: with a terminal attached and several agents found, an
#     interactive picker lets you tick the ones you want (↑/↓ + space + enter).
#   • No terminal (CI/containers) and no --agents → installs every agent found.
#
# CLI flags (after `bash -s --`):
#   --agents=LIST   comma-separated: hermes, openclaw, claude-code, codex, or "all"
#                   (aliases: cc/claude → claude-code, oc → openclaw)
#   --no-mirror     don't mirror terminal-side agent sessions into the app —
#                   only sessions you start from the app will appear
#                   (also disables the "terminal busy" indicator)
#   --mirror        force mirroring on (default; overrides MACCHIATO_MIRROR env)
#   -y, --yes       install every detected connector, no prompt
#   -h, --help      show usage and exit
#
# Env overrides:
#   MACCHIATO_SERVER_URL   (default wss://api.macchiato.chat/connector)
#   MACCHIATO_MIRROR       ("off" = same as --no-mirror; flags take precedence)
#   HERMES_PYTHON          (path to the python inside your Hermes venv, if auto-detect fails)
#   MACCHIATO_CLAUDE_BIN   (absolute path to the claude CLI, if auto-detect fails)
#   MACCHIATO_CODEX_BIN    (absolute path to the codex CLI, if auto-detect fails)
#   MACCHIATO_ONLY         ("hermes" | "openclaw" | "claude-code" | "codex" — legacy single-select;
#                           --agents supersedes it and takes a list)
#   MACCHIATO_MANIFEST     (path to a pre-verified release.json — self_update passes it;
#                           every installed file is sha256-checked against it before use)

set -euo pipefail

REPO_TARBALL="https://github.com/macchiato-chat/macchiato/tarball/main"
UNIT_DIR="$HOME/.config/systemd/user"

say()  { printf '\033[1;35m[macchiato]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[macchiato]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[macchiato] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

have_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }
have_launchd() { [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; }

# macOS (#15): launchd LaunchAgent — KeepAlive restarts on crash/exit (same semantics
# as systemd Restart=always; self-update exits after swapping code and relies on this).
install_launchd_unit() { # $1=unit-name $2=ExecStart $3=WorkingDirectory(optional)
  local label="chat.macchiato.$1"
  local agents="$HOME/Library/LaunchAgents" logs="$HOME/.macchiato/logs"
  local plist="$agents/$label.plist"
  mkdir -p "$agents" "$logs"
  # launchd gives agents a minimal PATH — resolve node's dir at install time so
  # `#!/usr/bin/env node` shebangs (tsx) keep working. Hermes python is absolute already.
  local path_env="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
  command -v node >/dev/null 2>&1 && path_env="$(dirname "$(command -v node)"):$path_env"
  # Honor MACCHIATO_UNIT_EXTRA_ENV (same contract as the systemd branch): PATH lines are
  # merged in front of our default; other KEY=VALUE lines become their own plist entries.
  local extra_env=""
  if [ -n "${MACCHIATO_UNIT_EXTRA_ENV:-}" ]; then
    while IFS= read -r kv; do
      [ -n "$kv" ] || continue
      case "$kv" in
        PATH=*) path_env="${kv#PATH=}:$path_env" ;;
        *) extra_env="$extra_env    <key>${kv%%=*}</key><string>${kv#*=}</string>
" ;;
      esac
    done <<< "$MACCHIATO_UNIT_EXTRA_ENV"
  fi
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo '  <key>ProgramArguments</key><array>'
    local arg
    for arg in $2; do echo "    <string>$arg</string>"; done # our ExecStarts are simple "bin path" pairs
    echo '  </array>'
    [ -n "${3:-}" ] && echo "  <key>WorkingDirectory</key><string>$3</string>"
    echo '  <key>RunAtLoad</key><true/>'
    echo '  <key>KeepAlive</key><true/>'
    echo '  <key>EnvironmentVariables</key><dict>'
    echo "    <key>PATH</key><string>$path_env</string>"
    echo '    <key>PYTHONUNBUFFERED</key><string>1</string>'
    [ -n "$extra_env" ] && printf '%s' "$extra_env"
    [ -n "${MACCHIATO_SERVER_URL:-}" ] && echo "    <key>MACCHIATO_SERVER_URL</key><string>$MACCHIATO_SERVER_URL</string>"
    echo '  </dict>'
    echo "  <key>StandardOutPath</key><string>$logs/$1.log</string>"
    echo "  <key>StandardErrorPath</key><string>$logs/$1.log</string>"
    echo '</dict></plist>'
  } > "$plist"
  local domain
  domain="gui/$(id -u)"
  # bootout first so re-running the installer to UPDATE loads the fresh code (mirrors
  # the systemd `restart` note below); ignore "not loaded" on first install.
  launchctl bootout "$domain/$label" 2>/dev/null || true
  launchctl bootstrap "$domain" "$plist" || fail "launchctl bootstrap failed for $label (try: launchctl bootstrap $domain $plist)"
  launchctl enable "$domain/$label" 2>/dev/null || true
  say "LaunchAgent $label running ✓   Update anytime by re-running this installer. Logs: tail -f $logs/$1.log"
}

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
    if have_launchd; then
      install_launchd_unit "$@"
      return 0
    fi
    warn "No systemd or launchd here — keep this running yourself:  $2"
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

# ═════════════════════════════ agent selection (#307) ═══════════════════════
# Parsed here (before the download) so --help and bad flags cost nothing.
# Pretty display name for a canonical agent key.
agent_label() {
  case "$1" in
    hermes)      echo "Hermes" ;;
    openclaw)    echo "OpenClaw" ;;
    claude-code) echo "Claude Code" ;;
    codex)       echo "Codex" ;;
    *)           echo "$1" ;;
  esac
}
# Comma-join a list of agent labels for human-readable messages.
labels_of() { local out="" a; for a in "$@"; do out="${out:+$out, }$(agent_label "$a")"; done; printf '%s' "$out"; }
# Comma-join raw keys (safe with zero args → empty). Callers pass ${arr[@]+"${arr[@]}"}
# so empty arrays don't trip `set -u` on bash 3.2 (macOS /bin/bash).
csv() { local IFS=,; echo "$*"; }

# Normalize a user-typed agent token (with aliases) → canonical key, or "" if unknown.
normalize_agent() {
  case "$1" in
    hermes|Hermes|HERMES)                                     echo "hermes" ;;
    openclaw|OpenClaw|OPENCLAW|oc)                            echo "openclaw" ;;
    claude-code|claude|Claude|cc|claudecode|claude_code|CC)   echo "claude-code" ;;
    codex|Codex|CODEX)                                        echo "codex" ;;
    *)                                                        echo "" ;;
  esac
}

REQUESTED=""    # space-separated canonical keys parsed from --agents / MACCHIATO_ONLY, or "all"
ASSUME_YES=0
MIRROR_MODE=""  # "" = undecided (env default → interactive prompt → on); "on" | "off"
add_requested() { # $1 = comma/space-separated token list
  local tok norm
  local IFS=', '
  for tok in $1; do
    [ -n "$tok" ] || continue
    if [ "$tok" = "all" ]; then REQUESTED="all"; return; fi
    norm="$(normalize_agent "$tok")"
    [ -n "$norm" ] || fail "Unknown agent '$tok' (valid: hermes, openclaw, claude-code, codex, all)"
    case " $REQUESTED " in *" $norm "*) ;; *) REQUESTED="${REQUESTED:+$REQUESTED }$norm" ;; esac
  done
}

usage() {
  cat <<'EOF'
Macchiato connector installer

  curl -sSL https://raw.githubusercontent.com/macchiato-chat/macchiato/main/install.sh | bash
  … | bash -s -- [options]

Options:
  --agents=LIST   comma-separated connectors to install:
                  hermes, openclaw, claude-code, codex, or "all"
                  (aliases: cc/claude → claude-code, oc → openclaw)
  --no-mirror     don't mirror terminal-side agent sessions into the app —
                  only sessions you start from the app will appear
                  (also disables the "terminal busy" indicator)
  --mirror        force mirroring on (default)
  -y, --yes       install every detected connector without prompting
  -h, --help      show this help

With no --agents and a terminal attached, an interactive picker appears when
more than one agent is detected. Without a terminal it installs all detected.
Mirroring defaults to ON; with a terminal attached a one-key [Y/n] prompt asks.
Re-running the installer rewrites the service, so re-run with --no-mirror /
--mirror anytime to flip the choice.
EOF
}

# ── parse CLI args (curl|bash passes them via `bash -s -- …`) ────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --agents=*)    add_requested "${1#*=}" ;;
    --agents|-A)   shift; [ $# -gt 0 ] || fail "--agents needs a value (e.g. --agents=claude-code,codex)"; add_requested "$1" ;;
    --all)         REQUESTED="all" ;;
    --no-mirror)   MIRROR_MODE="off" ;;
    --mirror)      MIRROR_MODE="on" ;;
    -y|--yes|--non-interactive) ASSUME_YES=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)             fail "Unknown option: $1 (try --help)" ;;
  esac
  shift
done
# Legacy MACCHIATO_ONLY (single-select) — honored only when --agents was not given.
[ -z "$REQUESTED" ] && [ -n "${MACCHIATO_ONLY:-}" ] && add_requested "$MACCHIATO_ONLY"
# MACCHIATO_MIRROR env (automation without flags) — flags above take precedence.
if [ -z "$MIRROR_MODE" ]; then
  case "$(printf '%s' "${MACCHIATO_MIRROR:-}" | tr '[:upper:]' '[:lower:]')" in
    off|0|false|no) MIRROR_MODE="off" ;;
    on|1|true|yes)  MIRROR_MODE="on" ;;
  esac
fi

# ── shared: download repo once ──────────────────────────────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Test-only (#307): selftest resolves the plan and exits before install — skip the download.
if [ "${MACCHIATO_SELFTEST:-0}" != 1 ]; then
  say "Downloading Macchiato connectors…"
  curl -sSL --fail --proto '=https' "$REPO_TARBALL" | tar -xz -C "$TMP" --strip-components=1
  [ -d "$TMP/connectors" ] || fail "Downloaded repo has no connectors/ (repo layout changed?)"
fi

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
  MACCHIATO_UNIT_EXTRA_ENV="${MIRROR_ENV:-}" install_unit "macchiato-connector" "$PY $APP/connector.py"
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
  MACCHIATO_UNIT_EXTRA_ENV="${MIRROR_ENV:-}" install_unit "macchiato-openclaw-connector" "$APP/node_modules/.bin/tsx src/index.ts" "$APP"
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
MACCHIATO_CLAUDE_BIN=$CLAUDE
${MIRROR_ENV:-}"     install_unit "macchiato-claude-code-connector" "$APP/node_modules/.bin/tsx src/index.ts" "$APP"
}

# ═════════════════════════════ Codex ════════════════════════════════════════
find_codex_bin() {
  if [ -n "${MACCHIATO_CODEX_BIN:-}" ]; then echo "$MACCHIATO_CODEX_BIN"; return; fi
  local cand
  cand="$(command -v codex 2>/dev/null || true)"
  [ -n "$cand" ] && { echo "$cand"; return; }
  for cand in "$HOME/.local/bin/codex" /usr/local/bin/codex /opt/homebrew/bin/codex "$HOME/.npm-global/bin/codex"; do
    [ -x "$cand" ] && { echo "$cand"; return; }
  done
  echo ""
}

install_codex() {
  local APP="$HOME/.macchiato/codex-app" CRED="$HOME/.macchiato/codex-connector.json" CODEX
  CODEX="$(find_codex_bin)"
  [ -n "$CODEX" ] || fail "Codex CLI not found. Install it first (https://developers.openai.com/codex), or set MACCHIATO_CODEX_BIN and re-run."
  command -v node >/dev/null 2>&1 || fail "node not found (the Codex connector requires Node 20+)"
  command -v npm >/dev/null 2>&1 || fail "npm not found"
  say "Codex connector → $APP  (codex: $CODEX)"
  verify_tree "$TMP/connectors/codex" "connectors/codex"
  mkdir -p "$APP"
  cp -r "$TMP"/connectors/codex/src "$TMP"/connectors/codex/package.json "$TMP"/connectors/codex/tsconfig.json "$APP/"
  (cd "$APP" && npm install --omit=dev --silent) || fail "npm install failed in $APP"
  if [ ! -f "$CRED" ]; then
    say "Pairing Codex connector (enter the code below at macchiato.chat)"
    (cd "$APP" && MACCHIATO_PAIR_ONLY=1 MACCHIATO_CODEX_BIN="$CODEX" ./node_modules/.bin/tsx src/index.ts) || fail "Pairing not completed. Re-run this script to continue."
  else
    say "Codex credentials found, skipping pairing"
  fi
  MACCHIATO_UNIT_EXTRA_ENV="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
MACCHIATO_CODEX_BIN=$CODEX
${MIRROR_ENV:-}"     install_unit "macchiato-codex-connector" "$APP/node_modules/.bin/tsx src/index.ts" "$APP"
}

# ── detect installed agents ─────────────────────────────────────────────────
HAS_HERMES=0; HAS_OPENCLAW=0; HAS_CLAUDE=0; HAS_CODEX=0
[ -n "$(find_hermes_python)" ] && HAS_HERMES=1
{ command -v openclaw >/dev/null 2>&1 || [ -f "$HOME/.openclaw/openclaw.json" ]; } && HAS_OPENCLAW=1
[ -n "$(find_claude_bin)" ] && HAS_CLAUDE=1
[ -n "$(find_codex_bin)" ] && HAS_CODEX=1
# Test-only (#307 smoke): under MACCHIATO_SELFTEST the detection is taken ENTIRELY from
# MACCHIATO_FAKE_DETECT (space-separated keys; empty = no agents) so the resolve/picker
# logic is executable without real agents — and "no agent" is expressible. Never active
# unless MACCHIATO_SELFTEST=1, and selftest exits before any real install.
if [ "${MACCHIATO_SELFTEST:-0}" = 1 ]; then
  HAS_HERMES=0; HAS_OPENCLAW=0; HAS_CLAUDE=0; HAS_CODEX=0
  for a in ${MACCHIATO_FAKE_DETECT:-}; do
    case "$a" in hermes) HAS_HERMES=1 ;; openclaw) HAS_OPENCLAW=1 ;; claude-code) HAS_CLAUDE=1 ;; codex) HAS_CODEX=1 ;; esac
  done
fi
DETECTED=()
[ "$HAS_HERMES" = 1 ]   && DETECTED+=("hermes")
[ "$HAS_OPENCLAW" = 1 ] && DETECTED+=("openclaw")
[ "$HAS_CLAUDE" = 1 ]   && DETECTED+=("claude-code")
[ "$HAS_CODEX" = 1 ]    && DETECTED+=("codex")

# ── interactive multi-select picker (arrow keys + space), drawn on /dev/tty ──
# Requires a real terminal; caller checks. Sets the global SELECTED array.
has_tty() { { true </dev/tty; } 2>/dev/null; }
SELECTED=()
pick_agents() {
  local -a keys=("$@")
  local n=${#keys[@]} i cur=0
  local -a on
  for ((i = 0; i < n; i++)); do on[i]=1; done   # default: everything ticked
  local saved; saved="$(stty -g </dev/tty)"
  # Ctrl-C during the picker: restore the terminal, then abort the whole install.
  trap 'stty "$saved" </dev/tty 2>/dev/null; printf "\033[?25h\n" >/dev/tty; exit 130' INT
  stty -echo -icanon min 1 time 0 </dev/tty 2>/dev/null || true
  printf '\033[?25l' >/dev/tty   # hide cursor while navigating

  local lines=$((n + 4)) drawn=0 key rest mark
  while :; do
    [ "$drawn" = 1 ] && printf '\033[%dA' "$lines" >/dev/tty
    drawn=1
    {
      printf '\r\033[2K  \033[1;35m✻\033[0m \033[1mMacchiato\033[0m \033[2m·\033[0m choose connectors to install\n'
      printf '\r\033[2K\n'
      for ((i = 0; i < n; i++)); do
        if [ "${on[i]}" = 1 ]; then mark=$'\033[32m◉\033[0m'; else mark=$'\033[2m○\033[0m'; fi
        if [ "$i" = "$cur" ]; then
          printf '\r\033[2K   \033[36m❯\033[0m %s \033[1;36m%s\033[0m\n' "$mark" "$(agent_label "${keys[i]}")"
        else
          printf '\r\033[2K     %s %s\n' "$mark" "$(agent_label "${keys[i]}")"
        fi
      done
      printf '\r\033[2K\n'
      printf '\r\033[2K   \033[2m↑/↓ move · space toggle · a all/none · enter confirm · q quit\033[0m\n'
    } >/dev/tty

    if ! IFS= read -rsn1 key </dev/tty 2>/dev/null; then key="__quit__"; fi
    case "$key" in
      $'\033')  # escape sequence — arrow keys send ESC [ A/B (or ESC O A/B)
        rest=""; IFS= read -rsn2 -t 0.05 rest </dev/tty 2>/dev/null || true
        case "$rest" in
          '[A' | 'OA') cur=$(((cur - 1 + n) % n)) ;;
          '[B' | 'OB') cur=$(((cur + 1) % n)) ;;
          *) : ;;  # bare ESC / unknown — ignore (only `q` quits, to dodge the ESC-vs-arrow race)
        esac ;;
      k) cur=$(((cur - 1 + n) % n)) ;;
      j) cur=$(((cur + 1) % n)) ;;
      ' ') on[cur]=$((1 - on[cur])) ;;
      a | A)
        local allon=1
        for ((i = 0; i < n; i++)); do [ "${on[i]}" = 1 ] || allon=0; done
        for ((i = 0; i < n; i++)); do on[i]=$((allon == 1 ? 0 : 1)); done ;;
      q | Q) key="__quit__"; break ;;
      '' | $'\n' | $'\r') break ;;   # enter → confirm
      __quit__) break ;;
    esac
  done

  trap - INT
  stty "$saved" </dev/tty 2>/dev/null || true
  printf '\033[?25h' >/dev/tty   # show cursor again
  if [ "$key" = "__quit__" ]; then
    printf '\n' >/dev/tty
    fail "Cancelled — nothing installed. Re-run anytime, or pass --agents=<list>."
  fi
  SELECTED=()
  for ((i = 0; i < n; i++)); do [ "${on[i]}" = 1 ] && SELECTED+=("${keys[i]}"); done
  [ "${#SELECTED[@]}" -gt 0 ] || fail "No connectors selected — re-run and tick at least one, or pass --agents=<list>."
}

# ── resolve what to install ─────────────────────────────────────────────────
if [ "$REQUESTED" = "all" ]; then
  SELECTED=(${DETECTED[@]+"${DETECTED[@]}"})    # may be empty on bash 3.2 → guard the expansion
  [ "${#SELECTED[@]}" -gt 0 ] || fail "No supported agent found (Hermes, OpenClaw, Claude Code or Codex). Install one first — see README."
elif [ -n "$REQUESTED" ]; then
  read -ra SELECTED <<< "$REQUESTED"          # explicit list — trust the user, install_* validates presence
elif [ "${#DETECTED[@]}" -eq 0 ]; then
  fail "No supported agent found (Hermes, OpenClaw, Claude Code or Codex). Install one first — see README."
elif [ "${#DETECTED[@]}" -eq 1 ]; then
  SELECTED=("${DETECTED[@]}")                  # only one candidate — nothing to choose
elif [ "$ASSUME_YES" = 1 ]; then
  SELECTED=("${DETECTED[@]}")
elif has_tty && stty -g </dev/tty >/dev/null 2>&1; then
  say "Detected ${#DETECTED[@]} agents: $(labels_of "${DETECTED[@]}")."
  pick_agents "${DETECTED[@]}"                 # interactive — sets SELECTED
else
  SELECTED=("${DETECTED[@]}")                  # no terminal to prompt → install all detected
  warn "Multiple agents detected ($(labels_of "${DETECTED[@]}")) and no terminal to prompt — installing all. Pass --agents=<list> to choose."
fi

# What was detected but left out (for the closing summary + re-run hint).
SKIPPED=()
for a in ${DETECTED[@]+"${DETECTED[@]}"}; do    # DETECTED may be empty (explicit --agents, nothing detected)
  case " ${SELECTED[*]} " in *" $a "*) ;; *) SKIPPED+=("$a") ;; esac
done

# ── mirror choice (#308): flag/env decided above; else one-key [Y/n] on a terminal ──
if [ -z "$MIRROR_MODE" ] && [ "$ASSUME_YES" != 1 ] && has_tty && stty -g </dev/tty >/dev/null 2>&1; then
  {
    printf '\n  \033[1;35m✻\033[0m \033[1mMirror terminal sessions into Macchiato?\033[0m\n'
    printf '    \033[2mMirror shows agent sessions you run in your terminal inside the app\n'
    printf '    (and lights the "busy" indicator). Sessions you start from the app\n'
    printf '    always work either way. Re-run with --no-mirror / --mirror to change.\033[0m\n'
    printf '    \033[36m[Y]\033[0m mirror on (default) · \033[36m[n]\033[0m app-driven only  '
  } >/dev/tty
  MKEY=""
  IFS= read -rsn1 MKEY </dev/tty 2>/dev/null || MKEY=""
  case "$MKEY" in
    n|N) MIRROR_MODE="off"; printf '→ \033[1mmirror off\033[0m\n' >/dev/tty ;;
    *)   MIRROR_MODE="on";  printf '→ \033[1mmirror on\033[0m\n'  >/dev/tty ;;
  esac
fi
[ -z "$MIRROR_MODE" ] && MIRROR_MODE="on"   # no terminal / -y → default on
# Connectors read MACCHIATO_MIRROR=off from their service env: polling stops (terminal
# sessions stay out of the app) while app-driven sessions keep working untouched.
MIRROR_ENV=""
[ "$MIRROR_MODE" = "off" ] && MIRROR_ENV="MACCHIATO_MIRROR=off"

# Test-only (#307/#308 smoke): print the resolved plan and stop before touching npm/pairing.
if [ "${MACCHIATO_SELFTEST:-0}" = 1 ]; then
  printf 'SELECTED:%s\n' "$(csv ${SELECTED[@]+"${SELECTED[@]}"})"
  printf 'SKIPPED:%s\n' "$(csv ${SKIPPED[@]+"${SKIPPED[@]}"})"
  printf 'MIRROR:%s\n' "$MIRROR_MODE"
  exit 0
fi

# ── run the chosen installers ───────────────────────────────────────────────
for a in "${SELECTED[@]}"; do
  case "$a" in
    hermes)      install_hermes ;;
    openclaw)    install_openclaw ;;
    claude-code) install_claude_code ;;
    codex)       install_codex ;;
    *)           fail "Internal: unknown agent '$a'" ;;
  esac
done

if [ "${#SKIPPED[@]}" -gt 0 ]; then
  say "Installed $(labels_of "${SELECTED[@]}"). Skipped $(labels_of "${SKIPPED[@]}") — re-run with --agents=$(IFS=,; echo "${SKIPPED[*]}") to add $([ "${#SKIPPED[@]}" -gt 1 ] && echo them || echo it)."
fi
say "Done! Open Macchiato — your conversations will start syncing."
