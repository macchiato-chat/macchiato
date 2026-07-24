#!/usr/bin/env bash
# Macchiato Connector installer (verified artifact entrypoint).
#
# MACCHIATO_VERIFIED_BUNDLE_V2
# Do not download or pipe this file directly. Start from the versioned,
# independently hash-pinned bootstrap command shown by the Macchiato app or
# https://macchiato.chat. Direct first install fails closed below.
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
# Hermes profiles (multiple independent Hermes agents on one machine):
#   Named profiles under ~/.hermes/profiles/<name> are detected automatically and
#   listed in the picker as "Hermes: <name>" — each installs its own connector
#   instance (own pairing → shows as a separate agent in the app). Explicitly:
#   … | bash -s -- --agents=hermes:coder   (default ~/.hermes stays plain "hermes")
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
#   MACCHIATO_MANIFEST     (path to a connector-preverified legacy manifest, or the
#                           bootstrap-verified v2 manifest)
#   MACCHIATO_VERIFIED_ROOT (private extracted v2 artifact root; bootstrap only)

set -euo pipefail

# Supported callers start this file with `bash -p`. Clear inherited functions
# and runtime/loader hooks again before any verified payload invokes tools.
while IFS= read -r inherited_function; do
  builtin unset -f "$inherited_function"
done < <(builtin compgen -A function)
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS NODE_PATH \
  PYTHONPATH PYTHONHOME PYTHONSTARTUP TAR_OPTIONS GZIP BZIP BZIP2 XZ_OPT \
  RUBYOPT RUBYLIB PERL5OPT PERL5LIB CURL_HOME \
  LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH \
  2>/dev/null || true
umask 077

ORIGINAL_ARGS=("$@")
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
  [ -n "${MACCHIATO_MANIFEST:-}" ] \
    || fail "missing verified manifest — direct/unverified install is forbidden"
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

# A legacy connector has already verified release.json with its embedded Ed25519
# key before launching this file. Bridge it into the v2 bootstrap whose exact hash
# is carried by that signed legacy manifest. A bare first install has no such proof
# and is deliberately rejected.
bridge_to_verified_bootstrap() {
  [ -n "${MACCHIATO_MANIFEST:-}" ] \
    || fail "unsafe direct install blocked — copy the verified command from the Macchiato app or https://macchiato.chat"
  [ -f "$MACCHIATO_MANIFEST" ] && [ ! -L "$MACCHIATO_MANIFEST" ] \
    || fail "pre-verified manifest is not a regular file"
  local version bootstrap_sha bridge_dir bootstrap_url bootstrap_path actual
  version="$(grep -E '^  "version": "[0-9]+\.[0-9]+\.[0-9]+",$' "$MACCHIATO_MANIFEST" | sed -E 's/.*"([^"]+)".*/\1/' | head -1 || true)"
  bootstrap_sha="$(grep -E '^  "bootstrapSha256": "[0-9a-f]{64}",?$' "$MACCHIATO_MANIFEST" | grep -oE '[0-9a-f]{64}' | head -1 || true)"
  [ -n "$version" ] && [ -n "$bootstrap_sha" ] \
    || fail "signed manifest lacks the v2 bootstrap bridge — update cannot continue safely"
  bridge_dir="$(command mktemp -d "${TMPDIR:-/tmp}/macchiato-bridge.XXXXXX")"
  bootstrap_path="$bridge_dir/bootstrap-v1.sh"
  bootstrap_url="https://raw.githubusercontent.com/macchiato-chat/macchiato/connectors-v$version/bootstrap-v1.sh"
  trap 'command rm -rf "$bridge_dir"' EXIT HUP INT TERM
  command curl --disable --silent --show-error --fail --proto '=https' --tlsv1.2 --max-redirs 0 \
    --connect-timeout 15 --max-time 120 --max-filesize 2097152 \
    --output "$bootstrap_path" "$bootstrap_url" \
    || fail "versioned bootstrap download failed (redirects are forbidden)"
  actual="$(sha256_of "$bootstrap_path")"
  [ "$actual" = "$bootstrap_sha" ] \
    || fail "versioned bootstrap sha256 mismatch — refusing to execute"
  /bin/bash -p "$bootstrap_path" --release="$version" --bootstrap-sha256="$bootstrap_sha" -- "${ORIGINAL_ARGS[@]}"
  local status=$?
  command rm -rf "$bridge_dir"
  trap - EXIT HUP INT TERM
  exit "$status"
}

if [ "${MACCHIATO_SELFTEST:-0}" != 1 ] && [ -z "${MACCHIATO_VERIFIED_ROOT:-}" ]; then
  case "${1:-}" in -h|--help) ;; *) bridge_to_verified_bootstrap ;; esac
fi

# ═════════════════════════════ agent selection (#307) ═══════════════════════
# Parsed after the trust bridge. --help remains available through bootstrap.
# Pretty display name for a canonical agent key.
agent_label() {
  case "$1" in
    hermes)      echo "Hermes" ;;
    hermes:*)    echo "Hermes: ${1#hermes:}" ;;   # #309 per-profile instance
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
    hermes:*|Hermes:*|HERMES:*)                               # #309 hermes profile — validate the name (same charset Hermes allows)
      case "${1#*:}" in
        ""|*[!a-z0-9_-]*) echo "" ;;
        *)                echo "hermes:${1#*:}" ;;
      esac ;;
    openclaw|OpenClaw|OPENCLAW|oc)                            echo "openclaw" ;;
    claude-code|claude|Claude|cc|claudecode|claude_code|CC)   echo "claude-code" ;;
    codex|Codex|CODEX)                                        echo "codex" ;;
    *)                                                        echo "" ;;
  esac
}

REQUESTED=""    # space-separated canonical keys parsed from --agents / MACCHIATO_ONLY, or "all"
ASSUME_YES=0
MIRROR_MODE=""  # "" = undecided (env default → interactive prompt → on); "on" | "off"
MIRROR_EXPLICIT=0  # 1 = flag/env 明確指定(覆蓋既有 unit 的設置);交互/默認只作用於新裝 agent
add_requested() { # $1 = comma/space-separated token list
  local tok norm
  local IFS=', '
  for tok in $1; do
    [ -n "$tok" ] || continue
    if [ "$tok" = "all" ]; then REQUESTED="all"; return; fi
    norm="$(normalize_agent "$tok")"
    [ -n "$norm" ] || fail "Unknown agent '$tok' (valid: hermes, hermes:<profile>, openclaw, claude-code, codex, all)"
    case " $REQUESTED " in *" $norm "*) ;; *) REQUESTED="${REQUESTED:+$REQUESTED }$norm" ;; esac
  done
}

usage() {
  cat <<'EOF'
Macchiato connector installer

  Start with the download → SHA-256 verify → execute command shown by the
  Macchiato app or https://macchiato.chat. Piping install.sh to bash is blocked.

Options:
  --agents=LIST   comma-separated connectors to install:
                  hermes, openclaw, claude-code, codex, or "all"
                  (aliases: cc/claude → claude-code, oc → openclaw)
                  Hermes profiles: hermes:<name> installs a connector for the
                  named profile (~/.hermes/profiles/<name>) — its own pairing,
                  shown as a separate agent in the app. Detected profiles also
                  appear in the interactive picker as "Hermes: <name>".
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
    --no-mirror)   MIRROR_MODE="off"; MIRROR_EXPLICIT=1 ;;
    --mirror)      MIRROR_MODE="on"; MIRROR_EXPLICIT=1 ;;
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
    off|0|false|no) MIRROR_MODE="off"; MIRROR_EXPLICIT=1 ;;
    on|1|true|yes)  MIRROR_MODE="on"; MIRROR_EXPLICIT=1 ;;
  esac
fi
# #309 self-update from a profile instance: the connector re-runs this installer with its
# own env (MACCHIATO_ONLY=hermes + MACCHIATO_HERMES_PROFILE=<name> from the service unit)
# — retarget the plain "hermes" request at that profile so the right instance is updated.
if [ -n "${MACCHIATO_HERMES_PROFILE:-}" ] && [ "$REQUESTED" != "all" ] && [ -n "$REQUESTED" ]; then
  _nr=""
  for a in $REQUESTED; do
    [ "$a" = "hermes" ] && a="hermes:$MACCHIATO_HERMES_PROFILE"
    _nr="${_nr:+$_nr }$a"
  done
  REQUESTED="$_nr"
fi

# ── shared: consume only the already-verified, safely extracted artifact ────
TMP=""
if [ "${MACCHIATO_SELFTEST:-0}" != 1 ]; then
  [ -n "${MACCHIATO_VERIFIED_ROOT:-}" ] \
    || fail "internal: verified artifact root is missing"
  case "$MACCHIATO_VERIFIED_ROOT" in /*) ;; *) fail "verified artifact root must be absolute" ;; esac
  [ -d "$MACCHIATO_VERIFIED_ROOT/connectors" ] \
    || fail "verified artifact has no connectors directory"
  TMP="$MACCHIATO_VERIFIED_ROOT"
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

install_hermes() { # $1 = Hermes profile name ("" / absent = the default ~/.hermes) — #309
  local PROFILE="${1:-}" HH="$HOME/.hermes" STATE="$HOME/.macchiato" UNIT="macchiato-connector" WHAT="Hermes"
  if [ -n "$PROFILE" ]; then
    HH="$HOME/.hermes/profiles/$PROFILE"
    [ -d "$HH" ] || fail "Hermes profile '$PROFILE' not found ($HH). Create it first: hermes profile create $PROFILE"
    STATE="$HOME/.macchiato/hermes-$PROFILE"   # per-instance files — never collide with other instances
    UNIT="macchiato-connector-$PROFILE"
    WHAT="Hermes profile '$PROFILE'"
  fi
  local PY APP="$STATE/app" CRED="$STATE/connector.json"
  PY="$(find_hermes_python)"
  [ -n "$PY" ] || fail "Hermes not found. Install it first (curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash), or set HERMES_PYTHON and re-run."
  "$PY" -c "import websockets" 2>/dev/null || fail "Hermes venv is missing websockets (required). Run: $PY -m pip install websockets"
  say "$WHAT connector → $APP  (python: $PY)"
  verify_tree "$TMP/connectors/hermes" "connectors/hermes"
  mkdir -p "$APP"
  cp "$TMP"/connectors/hermes/*.py "$APP/"
  # Per-instance env, threaded through pairing AND the service unit:
  #   HERMES_HOME → which hermes profile the connector (and its gateway subprocess) talks to
  #   MACCHIATO_STATE_DIR → where this instance keeps cred/mirror/health/…
  #   MACCHIATO_HERMES_PROFILE → self-update re-runs this installer for the right instance
  local PROFILE_ENV=""
  if [ -n "$PROFILE" ]; then
    PROFILE_ENV="HERMES_HOME=$HH
MACCHIATO_STATE_DIR=$STATE
MACCHIATO_HERMES_PROFILE=$PROFILE"
  fi
  if [ ! -f "$CRED" ]; then
    say "Pairing $WHAT connector (enter the code below at macchiato.chat)"
    if [ -n "$PROFILE" ]; then
      # Label carries the profile so the app can tell multiple Hermes agents apart.
      env "HERMES_HOME=$HH" "MACCHIATO_STATE_DIR=$STATE" "MACCHIATO_HERMES_PROFILE=$PROFILE" \
        "MACCHIATO_PAIR_BATCH=$PAIR_BATCH" "MACCHIATO_PAIR_BATCH_MANY=$PAIR_BATCH_MANY" \
        "$PY" "$APP/pair.py" || fail "Pairing not completed. Re-run this script to continue."
    else
      env "MACCHIATO_PAIR_BATCH=$PAIR_BATCH" "MACCHIATO_PAIR_BATCH_MANY=$PAIR_BATCH_MANY" \
        "$PY" "$APP/pair.py" || fail "Pairing not completed. Re-run this script to continue."
    fi
  else
    say "$WHAT credentials found, skipping pairing"
  fi
  MACCHIATO_UNIT_EXTRA_ENV="$PROFILE_ENV
$(mirror_env_for "$UNIT" "$WHAT")" install_unit "$UNIT" "$PY $APP/connector.py"
  # Platform plugin: lets Hermes proactively deliver to Macchiato (best effort).
  # Installed into THIS profile's home — its gateway loads it, and the plugin derives the
  # per-profile push socket from its own HERMES_HOME (same rule as the connector).
  if [ -d "$TMP/connectors/hermes/plugin/macchiato" ]; then
    mkdir -p "$HH/plugins"
    cp -r "$TMP/connectors/hermes/plugin/macchiato" "$HH/plugins/"
    if command -v hermes >/dev/null 2>&1; then
      if [ -n "$PROFILE" ]; then hermes -p "$PROFILE" plugins enable macchiato >/dev/null 2>&1 || true
      else hermes plugins enable macchiato >/dev/null 2>&1 || true; fi
    fi
    say "Hermes 'macchiato' platform plugin installed — restart your $WHAT gateway to load it"
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
    (cd "$APP" && MACCHIATO_PAIR_ONLY=1 MACCHIATO_PAIR_BATCH="$PAIR_BATCH" MACCHIATO_PAIR_BATCH_MANY="$PAIR_BATCH_MANY" ./node_modules/.bin/tsx src/index.ts) || fail "Pairing not completed. Re-run this script to continue."
  else
    say "OpenClaw credentials found, skipping pairing"
  fi
  MACCHIATO_UNIT_EXTRA_ENV="$(mirror_env_for macchiato-openclaw-connector OpenClaw)" install_unit "macchiato-openclaw-connector" "$APP/node_modules/.bin/tsx src/index.ts" "$APP"
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
    (cd "$APP" && MACCHIATO_PAIR_ONLY=1 MACCHIATO_CLAUDE_BIN="$CLAUDE" MACCHIATO_PAIR_BATCH="$PAIR_BATCH" MACCHIATO_PAIR_BATCH_MANY="$PAIR_BATCH_MANY" ./node_modules/.bin/tsx src/index.ts) || fail "Pairing not completed. Re-run this script to continue."
  else
    say "Claude Code credentials found, skipping pairing"
  fi
  # PATH: user systemd units often miss ~/.local/bin → the connector could not find the claude CLI.
  MACCHIATO_UNIT_EXTRA_ENV="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
MACCHIATO_CLAUDE_BIN=$CLAUDE
$(mirror_env_for macchiato-claude-code-connector "Claude Code")"     install_unit "macchiato-claude-code-connector" "$APP/node_modules/.bin/tsx src/index.ts" "$APP"
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
    (cd "$APP" && MACCHIATO_PAIR_ONLY=1 MACCHIATO_CODEX_BIN="$CODEX" MACCHIATO_PAIR_BATCH="$PAIR_BATCH" MACCHIATO_PAIR_BATCH_MANY="$PAIR_BATCH_MANY" ./node_modules/.bin/tsx src/index.ts) || fail "Pairing not completed. Re-run this script to continue."
  else
    say "Codex credentials found, skipping pairing"
  fi
  MACCHIATO_UNIT_EXTRA_ENV="PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
MACCHIATO_CODEX_BIN=$CODEX
$(mirror_env_for macchiato-codex-connector Codex)"     install_unit "macchiato-codex-connector" "$APP/node_modules/.bin/tsx src/index.ts" "$APP"
}

# ── detect installed agents ─────────────────────────────────────────────────
HAS_HERMES=0; HAS_OPENCLAW=0; HAS_CLAUDE=0; HAS_CODEX=0
HERMES_PROFILES=""   # #309: space-separated named-profile list ("" = only the default)
[ -n "$(find_hermes_python)" ] && HAS_HERMES=1
{ command -v openclaw >/dev/null 2>&1 || [ -f "$HOME/.openclaw/openclaw.json" ]; } && HAS_OPENCLAW=1
[ -n "$(find_claude_bin)" ] && HAS_CLAUDE=1
[ -n "$(find_codex_bin)" ] && HAS_CODEX=1
# #309: named Hermes profiles live at ~/.hermes/profiles/<name> (each a full HERMES_HOME;
# same enumeration Hermes' own `hermes profile list` uses — dirs matching its id charset).
find_hermes_profiles() {
  local d b
  for d in "$HOME/.hermes/profiles"/*/; do
    [ -d "$d" ] || continue
    b="${d%/}"; b="${b##*/}"
    case "$b" in
      default) ;;                                  # ~/.hermes itself is the default profile
      *[!a-z0-9_-]*|[!a-z0-9]*) ;;                 # invalid id charset / bad first char
      *) printf '%s ' "$b" ;;
    esac
  done
}
# Test-only (#307 smoke): under MACCHIATO_SELFTEST the detection is taken ENTIRELY from
# MACCHIATO_FAKE_DETECT (space-separated keys; empty = no agents) so the resolve/picker
# logic is executable without real agents — and "no agent" is expressible. Never active
# unless MACCHIATO_SELFTEST=1, and selftest exits before any real install.
# #309: `hermes:<name>` tokens fake named profiles (and imply Hermes itself exists).
if [ "${MACCHIATO_SELFTEST:-0}" = 1 ]; then
  HAS_HERMES=0; HAS_OPENCLAW=0; HAS_CLAUDE=0; HAS_CODEX=0
  for a in ${MACCHIATO_FAKE_DETECT:-}; do
    case "$a" in
      hermes) HAS_HERMES=1 ;;
      hermes:*) HAS_HERMES=1; HERMES_PROFILES="${HERMES_PROFILES}${a#hermes:} " ;;
      openclaw) HAS_OPENCLAW=1 ;;
      claude-code) HAS_CLAUDE=1 ;;
      codex) HAS_CODEX=1 ;;
    esac
  done
elif [ "$HAS_HERMES" = 1 ]; then
  HERMES_PROFILES="$(find_hermes_profiles)"
fi
DETECTED=()
[ "$HAS_HERMES" = 1 ]   && DETECTED+=("hermes")
for p in $HERMES_PROFILES; do DETECTED+=("hermes:$p"); done
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

# ── mirror per-agent 解析(#308 續):既有安裝沿用其現有設置,交互/默認答案只作用於新裝;
#    --mirror/--no-mirror/MACCHIATO_MIRROR 明確指定則對本次所選全部生效。 ──
previous_mirror() { # $1=unit-name → "off"/"on"(有既有 unit)或 ""(全新)
  local f="$UNIT_DIR/$1.service" p="$HOME/Library/LaunchAgents/chat.macchiato.$1.plist"
  if [ -f "$f" ]; then grep -q "MACCHIATO_MIRROR=off" "$f" && echo off || echo on; return; fi
  if [ -f "$p" ]; then grep -q "<key>MACCHIATO_MIRROR</key><string>off</string>" "$p" && echo off || echo on; return; fi
  echo ""
}
mirror_env_for() { # $1=unit-name $2=顯示名 → stdout 給 unit 的 env 行(或空);結論 say 到 stderr
  local prev mode note=""
  prev="$(previous_mirror "$1")"
  if [ "$MIRROR_EXPLICIT" = 1 ] || [ -z "$prev" ]; then
    mode="$MIRROR_MODE"
  else
    mode="$prev"
    [ "$prev" != "$MIRROR_MODE" ] && note=" (kept from previous install — pass --mirror/--no-mirror to change)"
  fi
  say "$2 mirror: $mode$note" >&2
  [ "$mode" = "off" ] && echo "MACCHIATO_MIRROR=off"
  return 0
}


# Test-only (#307/#308 smoke): print the resolved plan and stop before touching npm/pairing.
if [ "${MACCHIATO_SELFTEST:-0}" = 1 ]; then
  printf 'SELECTED:%s\n' "$(csv ${SELECTED[@]+"${SELECTED[@]}"})"
  printf 'SKIPPED:%s\n' "$(csv ${SKIPPED[@]+"${SKIPPED[@]}"})"
  printf 'MIRROR:%s\n' "$MIRROR_MODE"
  exit 0
fi

# #388 一碼多綁:本次安裝的批次 id(高熵,僅在連接器→server 的 WSS 內傳輸)。
# 同批第一個配對碼被 claim 後,其餘 agent 在窗口內免碼自動綁定;老 server 忽略,各自出碼。
PAIR_BATCH="$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n')"
PAIR_BATCH_MANY=""
[ "${#SELECTED[@]}" -gt 1 ] && PAIR_BATCH_MANY=1

# ── run the chosen installers ───────────────────────────────────────────────
for a in "${SELECTED[@]}"; do
  case "$a" in
    hermes)      install_hermes ;;
    hermes:*)    install_hermes "${a#hermes:}" ;;   # #309 per-profile instance
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
