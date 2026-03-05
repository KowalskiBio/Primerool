#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
#  Primerool – one-click launcher (macOS / Linux)
# ──────────────────────────────────────────────────────────
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# ── colours ────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}▸${NC} $1"; }
ok()    { echo -e "${GREEN}✔${NC} $1"; }
fail()  { echo -e "${RED}✖ $1${NC}"; exit 1; }

# ── setup local paths ──────────────────────────────────────
NODE_DIR="$ROOT/.bin/node"

if [ -d "$NODE_DIR/bin" ]; then
    export PATH="$NODE_DIR/bin:$PATH"
fi

# ── prerequisite checks ───────────────────────────────────
command -v python3 >/dev/null 2>&1 || fail "Python 3 is required but not found. Install from https://python.org"

if ! command -v node >/dev/null 2>&1; then
    info "Node.js not found. Downloading portable Node.js..."
    NODE_VERSION="v22.14.0"
    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"
    if [ "$ARCH" = "x86_64" ]; then ARCH="x64"; fi
    if [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; fi
    mkdir -p "$NODE_DIR"
    curl -sL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${OS}-${ARCH}.tar.gz" | tar -xz -C "$NODE_DIR" --strip-components=1
    export PATH="$NODE_DIR/bin:$PATH"
fi

ok "Python $(python3 --version 2>&1 | awk '{print $2}')"
ok "Node   $(node --version)"

# ── Python virtual-env & dependencies ─────────────────────
if [ ! -d "$ROOT/.venv" ]; then
    info "Creating Python virtual environment…"
    python3 -m venv "$ROOT/.venv"
fi
source "$ROOT/.venv/bin/activate"
info "Installing Python dependencies…"
pip install -q -r "$ROOT/requirements.txt"
ok "Python packages ready"

# ── Node dependencies ─────────────────────────────────────
if [ ! -d "$ROOT/frontend/node_modules" ]; then
    info "Installing Node dependencies (first run)…"
    (cd "$ROOT/frontend" && npm install)
fi
ok "Node packages ready"

# ── cleanup on exit ───────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""
cleanup() {
    echo ""
    info "Shutting down…"
    [ -n "$BACKEND_PID"  ] && kill "$BACKEND_PID"  2>/dev/null && ok "Backend stopped"
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null && ok "Frontend stopped"
    exit 0
}
trap cleanup INT TERM

# ── start backend ─────────────────────────────────────────
info "Starting backend on http://localhost:5050 …"
(cd "$ROOT" && python3 backend/main.py) &
BACKEND_PID=$!

# ── start frontend ────────────────────────────────────────
info "Starting frontend on http://localhost:5173 …"
(cd "$ROOT/frontend" && npm run dev -- --host 0.0.0.0) &
FRONTEND_PID=$!

# ── start native desktop window ───────────────────────────
info "Opening application window (Development Mode)…"
(cd "$ROOT" && python3 webview_app.py --dev)

echo ""

cleanup
