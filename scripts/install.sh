#!/usr/bin/env bash
#
# Tariffia Router — first-time VPS installer (Linux + systemd).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/fileboin/tariffia-router/main/scripts/install.sh | sudo bash
#
# Requirements: Linux with systemd, root (sudo), and Node.js >= 20 already installed.
# This script does NOT install system packages (including Node.js) for you — it stops
# with a clear message instead.
#
# It is idempotent: re-running updates the checkout/build, keeps the existing bearer
# token, rewrites the same unit, and restarts the service.
#
# Security: provider API keys are NOT handled here. Only the Router's own bearer token
# is generated/stored, in a root-only file (/etc/tariffia-router.env, mode 0600). The
# token is never passed on a command line.

set -euo pipefail

REPO_URL="https://github.com/fileboin/tariffia-router.git"
DEFAULT_REPO_DIR="/opt/tariffia-router"
ENV_FILE="/etc/tariffia-router.env"
UNIT_FILE="/etc/systemd/system/tariffia-router.service"
SERVICE="tariffia-router"
HOST="0.0.0.0"
PORT="8910"

log()  { printf '%s\n' "tariffia-install: $*"; }
fail() { printf '%s\n' "tariffia-install: ERROR: $*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || fail "this installer supports Linux only."
[ -d /run/systemd/system ] || fail "systemd is required (no /run/systemd/system)."
command -v systemctl >/dev/null 2>&1 || fail "systemctl not found."
[ "$(id -u)" -eq 0 ] || fail "run as root (for example: sudo bash install.sh)."
command -v git >/dev/null 2>&1 || fail "git is required."
command -v npm >/dev/null 2>&1 || fail "npm is required. Install Node.js >= 20 and re-run (this script will not install it)."
command -v node >/dev/null 2>&1 || fail "Node.js is required. Install Node.js >= 20 and re-run (this script will not install it)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if ! [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
  fail "Node.js >= 20 required (found $(node -v)). Install Node.js >= 20 and re-run (this script will not install it)."
fi
NODE_BIN="$(command -v node)"

# --- locate or clone the repository -----------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd || pwd)"
if git -C "$SCRIPT_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
  REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
else
  REPO_DIR="$DEFAULT_REPO_DIR"
fi
log "repository directory: $REPO_DIR"

if [ -d "$REPO_DIR/.git" ]; then
  log "updating existing checkout..."
  git -C "$REPO_DIR" fetch --prune origin
  git -C "$REPO_DIR" reset --hard origin/main
else
  log "cloning $REPO_URL ..."
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --depth 1 "$REPO_URL" "$REPO_DIR"
fi

# --- build -------------------------------------------------------------------
log "installing dependencies (npm ci)..."
( cd "$REPO_DIR" && npm ci --no-audit --no-fund )
log "building (npm run build)..."
( cd "$REPO_DIR" && npm run build )

# --- bearer token + env (idempotent: keep an existing token) -----------------
TOKEN=""
if [ -f "$ENV_FILE" ]; then
  TOKEN="$(grep -E '^TARIFFIA_TOKEN=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
fi
if [ -z "$TOKEN" ] && [ -n "${TARIFFIA_TOKEN:-}" ]; then
  TOKEN="$TARIFFIA_TOKEN"
fi
if [ -z "$TOKEN" ]; then
  if command -v openssl >/dev/null 2>&1; then
    TOKEN="$(openssl rand -hex 32)"
  else
    TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  fi
  log "generated a new TARIFFIA_TOKEN."
else
  log "keeping the existing TARIFFIA_TOKEN."
fi

umask 077
cat > "$ENV_FILE" <<EOF
TARIFFIA_HOST=$HOST
TARIFFIA_PORT=$PORT
TARIFFIA_MODE=FREE_ONLY
TARIFFIA_REGISTRY=$REPO_DIR/registry/ollama.json
TARIFFIA_TOKEN=$TOKEN
EOF
chmod 600 "$ENV_FILE"
log "wrote $ENV_FILE (mode 0600)."

# --- systemd unit ------------------------------------------------------------
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Tariffia Router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $REPO_DIR/dist/src/cli/index.js serve
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
log "wrote $UNIT_FILE."

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

# --- health check ------------------------------------------------------------
log "waiting for /healthz ..."
ok=""
for _ in {1..30}; do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS -o /dev/null -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then
      ok=1; break
    fi
  elif TARIFFIA_TOKEN="$TOKEN" TARIFFIA_PORT="$PORT" "$NODE_BIN" -e \
    'fetch("http://127.0.0.1:"+process.env.TARIFFIA_PORT+"/healthz",{headers:{Authorization:"Bearer "+process.env.TARIFFIA_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then
    ok=1; break
  fi
  sleep 1
done

if [ -z "$ok" ]; then
  fail "the service did not answer /healthz on 127.0.0.1:$PORT. Check: journalctl -u $SERVICE -n 50"
fi

# --- summary -----------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<vps-ip>"
cat <<EOF

tariffia-install: Router is running.

  Router dir : $REPO_DIR
  Base URL   : http://$IP:$PORT/v1   (OpenAI-compatible)
  Health     : http://$IP:$PORT/healthz
  Token      : $TOKEN
  Env file   : $ENV_FILE (root only)
  Status     : systemctl status $SERVICE
  Logs       : journalctl -u $SERVICE -f

Provider API keys are NOT set by this installer. Add them to $ENV_FILE
(using the env names from your registry) and run: systemctl restart $SERVICE

EOF
