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
find_hermes_python() {
  if [ -n "${HERMES_PYTHON:-}" ]; then echo "$HERMES_PYTHON"; return; fi
  local cand
  for cand in \
    "$HOME/.local/share/pipx/venvs/hermes-agent/bin/python" \
    "$HOME/.local/pipx/venvs/hermes-agent/bin/python"; do
    [ -x "$cand" ] && { echo "$cand"; return; }
  done
  echo ""
}

PY="$(find_hermes_python)"
[ -n "$PY" ] || fail "找不到 Hermes（hermes-agent pipx venv）。請先安裝 Hermes，或設 HERMES_PYTHON=<venv 的 python 路徑> 後重跑。"
"$PY" -c "import websockets" 2>/dev/null || fail "Hermes venv 缺 websockets（連接器依賴）。跑: $PY -m pip install websockets"
say "Hermes Python: $PY"

# ── 2. download connector ──────────────────────────────────────────────────
say "下載連接器 → $APP_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sSL "$REPO_TARBALL" | tar -xz -C "$TMP" --strip-components=1
[ -d "$TMP/connectors/hermes" ] || fail "下載的倉庫裡沒有 connectors/hermes（倉庫結構變了？）"
mkdir -p "$APP_DIR"
cp "$TMP"/connectors/hermes/*.py "$APP_DIR/"

# ── 3. pair (first time only) ──────────────────────────────────────────────
if [ ! -f "$CRED" ]; then
  say "首次安裝：開始配對（在 Macchiato 網頁/App 輸入下面顯示的配對碼）"
  "$PY" "$APP_DIR/pair.py" || fail "配對未完成。重跑本腳本繼續。"
else
  say "已有憑證（$CRED），跳過配對"
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
  # 無人值守機器建議: loginctl enable-linger $USER（開機即啟，無需登錄）
  say "服務已啟動 ✓   看日誌: journalctl --user -u $UNIT_NAME -f"
else
  say "非 systemd 環境：請自行常駐運行  $PY $APP_DIR/connector.py"
fi

say "完成！打開 Macchiato，對話會開始同步。"
