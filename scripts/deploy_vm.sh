#!/bin/bash
# Deploys the current branch of this primerool-src checkout to this VM's
# live service (systemd --user primerool.service, serving
# ~/Primerool/primerool-server + ~/Primerool/frontend/dist behind nginx).
#
# Run from inside the checkout: ./scripts/deploy_vm.sh
#
# Safety:
#   - refuses to run with local uncommitted changes
#   - only fast-forwards from origin (never resets/force-pulls)
#   - builds into scratch locations before touching anything live
#   - takes a full timestamped backup of the live directory before
#     swapping in the new build
#   - health-checks after restart and automatically rolls back to that
#     backup (and restarts the service again) if the check fails
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_DIR="$HOME/Primerool"
BACKUP_DIR="$HOME/Primerool.autobak.$(date +%Y%m%d-%H%M%S)"
SERVICE="primerool.service"
HEALTH_URL="http://127.0.0.1:8002/_health"
KEEP_BACKUPS=5

[ -x "$HOME/.cargo/bin/cargo" ] && export PATH="$HOME/.cargo/bin:$PATH"

cd "$SRC_DIR"

echo "==> Checking working tree is clean"
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: $SRC_DIR has uncommitted changes — aborting so nothing gets clobbered." >&2
  git status --short
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "==> Fast-forwarding $BRANCH from origin"
git fetch origin "$BRANCH"
git merge --ff-only "origin/$BRANCH"
COMMIT="$(git rev-parse --short HEAD)"
echo "==> Deploying $BRANCH @ $COMMIT"

echo "==> Building server (release)"
cargo build --release --locked -p server

echo "==> Building frontend"
(cd frontend && npm ci && npm run build)

echo "==> Backing up current live deployment -> $BACKUP_DIR"
cp -a "$LIVE_DIR" "$BACKUP_DIR"

echo "==> Installing new binary"
cp "$SRC_DIR/target/release/primerool-server" "$LIVE_DIR/primerool-server.new"
mv "$LIVE_DIR/primerool-server.new" "$LIVE_DIR/primerool-server"

echo "==> Installing new frontend build"
rm -rf "$LIVE_DIR/frontend/dist.new"
cp -a "$SRC_DIR/frontend/dist" "$LIVE_DIR/frontend/dist.new"
mv "$LIVE_DIR/frontend/dist" "$LIVE_DIR/frontend/dist.tmp_out"
mv "$LIVE_DIR/frontend/dist.new" "$LIVE_DIR/frontend/dist"
rm -rf "$LIVE_DIR/frontend/dist.tmp_out"

echo "==> Restarting $SERVICE"
systemctl --user restart "$SERVICE"

echo "==> Health-checking $HEALTH_URL"
ok=0
for _ in $(seq 1 15); do
  if curl -fsS -o /dev/null "$HEALTH_URL"; then
    ok=1
    break
  fi
  sleep 1
done

if [ "$ok" != 1 ]; then
  echo "ERROR: health check failed after restart — rolling back to $BACKUP_DIR" >&2
  systemctl --user stop "$SERVICE" || true
  rm -rf "$LIVE_DIR"
  cp -a "$BACKUP_DIR" "$LIVE_DIR"
  systemctl --user start "$SERVICE"
  echo "Rolled back. $BACKUP_DIR left in place for inspection." >&2
  exit 1
fi

echo "==> Pruning old auto-backups (keeping newest $KEEP_BACKUPS)"
ls -1dt "$HOME"/Primerool.autobak.* 2>/dev/null | tail -n "+$((KEEP_BACKUPS + 1))" | xargs -r rm -rf

echo "==> Deploy OK — $COMMIT is live and healthy."
