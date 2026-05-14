#!/usr/bin/env bash
# deploy.sh — Push code changes from your laptop/Codespace to the GCP VM.
#
# Usage:
#   ./scripts/deploy.sh                     # pull + install + graceful restart
#   ./scripts/deploy.sh --no-restart        # pull + install only (no service bounce)
#   ./scripts/deploy.sh --restart-only      # just restart the service (no pull)
#   ./scripts/deploy.sh --status            # check current VM status, no deploy
#   ./scripts/deploy.sh --rollback <sha>    # roll back to a specific commit
#
# Prerequisites:
#   gcloud CLI authenticated:  gcloud auth login
#   Project set:               gcloud config set project aerial-vehicle-466722-p5
#   IAP enabled on the VM:     (already configured — IAP-only SSH, no public port 22)

set -euo pipefail

# ── config (override via env vars) ───────────────────────────────────────────
PROJECT="${GCP_PROJECT:-aerial-vehicle-466722-p5}"
ZONE="${GCP_ZONE:-us-central1-a}"
INSTANCE="${GCP_INSTANCE:-swarm-agent}"
REMOTE_USER="${REMOTE_USER:-agent}"
APP_DIR="${REMOTE_APP_DIR:-/home/agent/ai-agents-x-space}"
SERVICE="${SYSTEMD_SERVICE:-swarm-server.service}"
RESTART_WAIT="${RESTART_WAIT_SECS:-8}"
LOG_TAIL="${LOG_TAIL_SECS:-15}"

# ── colours ───────────────────────────────────────────────────────────────────
C_R='\033[0m'; C_G='\033[32m'; C_Y='\033[33m'; C_Re='\033[31m'; C_B='\033[1m'; C_D='\033[2m'
ok()   { echo -e "${C_G}✓${C_R}  $*"; }
warn() { echo -e "${C_Y}⚠${C_R}  $*"; }
fail() { echo -e "${C_Re}✗${C_R}  $*" >&2; }
step() { echo -e "\n${C_B}── $* ──${C_R}"; }
dim()  { echo -e "${C_D}   $*${C_R}"; }

# ── args ──────────────────────────────────────────────────────────────────────
NO_RESTART=false
RESTART_ONLY=false
STATUS_ONLY=false
ROLLBACK_SHA=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-restart)    NO_RESTART=true ;;
    --restart-only)  RESTART_ONLY=true ;;
    --status)        STATUS_ONLY=true ;;
    --rollback)      shift; ROLLBACK_SHA="${1:-}"; [[ -z "$ROLLBACK_SHA" ]] && { fail "--rollback requires a SHA"; exit 1; } ;;
    --project)       shift; PROJECT="$1" ;;
    --zone)          shift; ZONE="$1" ;;
    --instance)      shift; INSTANCE="$1" ;;
    --help|-h)
      sed -n '2,12p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0 ;;
    *) fail "Unknown argument: $1"; exit 1 ;;
  esac
  shift
done

# ── gcloud check ─────────────────────────────────────────────────────────────
if ! command -v gcloud >/dev/null 2>&1; then
  fail "gcloud not found — install Google Cloud SDK: https://cloud.google.com/sdk"
  fail "In Codespaces: export PATH=\"\$PATH:/home/codespace/google-cloud-sdk/bin\""
  exit 1
fi

GCLOUD_PROJECT=$(gcloud config get-value project 2>/dev/null || echo "")
if [[ "$GCLOUD_PROJECT" != "$PROJECT" ]]; then
  warn "Active gcloud project ($GCLOUD_PROJECT) differs from target ($PROJECT)"
  warn "Run: gcloud config set project $PROJECT"
fi

SSH() {
  gcloud compute ssh "$INSTANCE" \
    --project="$PROJECT" \
    --zone="$ZONE" \
    --tunnel-through-iap \
    --command="$1" \
    --quiet 2>/dev/null
}

echo -e "${C_B}Deploy target: ${INSTANCE} (${PROJECT} / ${ZONE})${C_R}"

# ── --status only ─────────────────────────────────────────────────────────────
if $STATUS_ONLY; then
  step "VM status"
  SSH "
    echo '── Service ──'
    sudo systemctl status $SERVICE --no-pager --lines=5 2>/dev/null || echo 'service not found'
    echo
    echo '── Git ──'
    cd '$APP_DIR' && git log --oneline -5
    echo
    echo '── Agents ──'
    curl -sf http://localhost:3000/state 2>/dev/null | python3 -c \"
import sys, json
d = json.load(sys.stdin)
for id, a in d.get('agents', {}).items():
    print(f'  Agent {id} ({a.get(\"name\",\"?\")}) - {a.get(\"status\")} - connected:{a.get(\"connected\")}')
\" 2>/dev/null || echo '  (server not responding)'
    echo
    echo '── Chrome CDP ──'
    for p in 9222 9223 9224 9225; do
      curl -sf http://127.0.0.1:\$p/json/version -o /dev/null -w \":$p %{http_code}\\n\" 2>/dev/null || echo \":$p DOWN\"
    done
  "
  exit 0
fi

# ── --rollback ────────────────────────────────────────────────────────────────
if [[ -n "$ROLLBACK_SHA" ]]; then
  step "Rolling back to $ROLLBACK_SHA"
  warn "This will hard-reset the VM's working tree. Any uncommitted changes there will be lost."
  read -r -p "  Confirm rollback to $ROLLBACK_SHA? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
  SSH "
    cd '$APP_DIR'
    git fetch origin
    git reset --hard '$ROLLBACK_SHA'
    pnpm install --frozen-lockfile
    sudo systemctl restart '$SERVICE'
    sleep $RESTART_WAIT
    sudo systemctl status '$SERVICE' --no-pager --lines=10
  "
  ok "Rollback complete"
  exit 0
fi

# ── deploy ────────────────────────────────────────────────────────────────────
START=$(date +%s)

if ! $RESTART_ONLY; then
  step "1 — Pull latest code"
  LOCAL_SHA=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  LOCAL_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  dim "Local branch: $LOCAL_BRANCH @ $LOCAL_SHA"

  SSH "
    set -e
    cd '$APP_DIR'
    echo 'Remote before:'
    git log --oneline -3
    git fetch origin
    git reset --hard origin/main
    echo 'Remote after:'
    git log --oneline -3
  "
  ok "Code updated"

  step "2 — Install dependencies (if package.json changed)"
  SSH "
    cd '$APP_DIR'
    if git diff HEAD~1 --name-only 2>/dev/null | grep -q 'package.json\|pnpm-lock.yaml'; then
      echo 'package.json changed — running pnpm install'
      pnpm install --frozen-lockfile
    else
      echo 'package.json unchanged — skipping install'
    fi
  "
  ok "Dependencies ready"
fi

if ! $NO_RESTART; then
  step "3 — Graceful service restart"
  dim "Sending SIGTERM to allow in-flight requests to drain (${RESTART_WAIT}s)..."
  SSH "
    sudo systemctl stop '$SERVICE' 2>/dev/null || true
    sleep 2
    sudo systemctl start '$SERVICE'
    sleep $RESTART_WAIT
  "

  step "4 — Verify startup"
  STATUS=$(SSH "sudo systemctl is-active '$SERVICE' 2>/dev/null || echo failed")
  if [[ "$STATUS" == "active" ]]; then
    ok "Service is active"
  else
    fail "Service status: $STATUS"
    SSH "journalctl -u '$SERVICE' -n 30 --no-pager" || true
    exit 1
  fi

  HTTP=$(SSH "curl -sf -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null || echo 000")
  if [[ "$HTTP" == "200" ]]; then
    ok "Server responding (HTTP 200)"
  else
    fail "Server not responding (HTTP $HTTP)"
    exit 1
  fi

  step "5 — Tail logs (${LOG_TAIL}s)"
  SSH "journalctl -u '$SERVICE' -f --no-pager --lines=20" &
  LOG_PID=$!
  sleep "$LOG_TAIL"
  kill "$LOG_PID" 2>/dev/null || true
fi

# ── summary ───────────────────────────────────────────────────────────────────
END=$(date +%s)
ELAPSED=$((END - START))
echo
echo -e "${C_G}${C_B}═══════════════════════════════${C_R}"
echo -e "${C_G}${C_B}  Deploy complete in ${ELAPSED}s     ${C_R}"
echo -e "${C_G}${C_B}═══════════════════════════════${C_R}"
echo
dim "SSH:       gcloud compute ssh $INSTANCE --tunnel-through-iap --zone=$ZONE"
dim "Logs:      ./scripts/deploy.sh --status"
dim "Roll back: ./scripts/deploy.sh --rollback <sha>"
