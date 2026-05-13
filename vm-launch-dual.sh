#!/usr/bin/env bash
# vm-launch-dual.sh — Run on the swarm-agent VM as user 'agent'.
# Boots Xvfb → PulseAudio → Node server → 4 Chrome instances → automation.
#
# Usage:
#   ./vm-launch-dual.sh <space-url>
#   ./vm-launch-dual.sh https://x.com/i/spaces/1PKqrELveOnGb
#
# Env (read from /home/agent/x-spaces-v2/.env if present):
#   ADMIN_API_KEY  — required; gated server
#   OPENAI_API_KEY, ELEVENLABS_API_KEY — AI providers
#   TTS_MODE       — "realtime" (default) | "elevenlabs"
#   X_AUTH_TOKEN, X_CT0              — @swarminged cookies
#   X_AUTH_TOKEN_EPLUS, X_CT0_EPLUS  — @eplus cookies
set -euo pipefail

SPACE_URL="${1:-}"
if [ -z "$SPACE_URL" ]; then
  echo "usage: $0 <https://x.com/i/spaces/...>"
  exit 1
fi

SERVER_DIR="/home/agent/x-spaces-v2"
LOG="$SERVER_DIR/launch-dual.log"
ENV_FILE="$SERVER_DIR/.env"

echo "=== launch-dual at $(date) ===" | tee -a "$LOG"
echo "[launch] Space: $SPACE_URL" | tee -a "$LOG"

# Load .env
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
fi

ADMIN_KEY="${ADMIN_API_KEY:-}"
TTS_MODE="${TTS_MODE:-realtime}"

# ── 1. Xvfb ──────────────────────────────────────────────────────────────
if ! pgrep -f "Xvfb :99" >/dev/null; then
  Xvfb :99 -screen 0 1280x800x24 -ac +extension RANDR >>"$LOG" 2>&1 &
  sleep 1
fi
export DISPLAY=:99
echo "[launch] Xvfb up" | tee -a "$LOG"

# ── 2. PulseAudio ────────────────────────────────────────────────────────
pulseaudio --kill 2>/dev/null || true
sleep 1
pulseaudio --start --exit-idle-time=-1 --log-target="file:$SERVER_DIR/pulse.log"
sleep 2
echo "[launch] PulseAudio up" | tee -a "$LOG"
pactl list short sinks 2>/dev/null | tee -a "$LOG" || true
pactl list short sources 2>/dev/null | tee -a "$LOG" || true

# ── 3. Node server ───────────────────────────────────────────────────────
pkill -f "node.*server.js" 2>/dev/null || true
sleep 1
cd "$SERVER_DIR"
nohup node server.js >>"$SERVER_DIR/server.log" 2>&1 &
SERVER_PID=$!
echo "[launch] node server PID $SERVER_PID" | tee -a "$LOG"

# Wait for server to answer
for i in $(seq 1 20); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT:-3000}/health" \
      -H "Authorization: Bearer $ADMIN_KEY" 2>/dev/null || \
     curl -sf -o /dev/null "http://127.0.0.1:${PORT:-3000}/" 2>/dev/null; then
    echo "[launch] server ready (attempt $i)" | tee -a "$LOG"
    break
  fi
  sleep 1
done

# ── 4. Kill old Chrome instances ─────────────────────────────────────────
pkill -f "chrome.*user-data-dir=/tmp/chrome-" 2>/dev/null || true
sleep 1
rm -rf /tmp/chrome-agent1 /tmp/chrome-agent2 /tmp/chrome-swarming /tmp/chrome-eplus

CHROME=/usr/bin/google-chrome
BASE_FLAGS=(
  --no-default-browser-check
  --no-first-run
  --no-sandbox
  --use-fake-ui-for-media-stream
  --autoplay-policy=no-user-gesture-required
  --disable-features=MediaRouter,AudioServiceOutOfProcess
  --allow-running-insecure-content
)

KEY_PARAM=""
if [ -n "$ADMIN_KEY" ]; then
  KEY_PARAM="?key=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$ADMIN_KEY")"
fi

AGENT1_URL="http://127.0.0.1:${PORT:-3000}/server-agent1${KEY_PARAM}"
AGENT2_URL="http://127.0.0.1:${PORT:-3000}/server-agent2${KEY_PARAM}"

if [ "$TTS_MODE" = "elevenlabs" ]; then
  AGENT1_URL="${AGENT1_URL}&tts=elevenlabs"
  AGENT2_URL="${AGENT2_URL}&tts=elevenlabs"
fi

echo "[launch] Agent1 URL: $AGENT1_URL" | tee -a "$LOG"
echo "[launch] Agent2 URL: $AGENT2_URL" | tee -a "$LOG"

# Agent 1 Chrome — Swarm (@swarminged pipeline)
PULSE_SINK=agent1_speakers PULSE_SOURCE=agent1_mic DISPLAY=:99 \
  $CHROME "${BASE_FLAGS[@]}" \
  --user-data-dir=/tmp/chrome-agent1 \
  --remote-debugging-port=9222 \
  "$AGENT1_URL" >>"$LOG" 2>&1 &

# Agent 2 Chrome — Swarm2 (@eplus pipeline)
PULSE_SINK=agent2_speakers PULSE_SOURCE=agent2_mic DISPLAY=:99 \
  $CHROME "${BASE_FLAGS[@]}" \
  --user-data-dir=/tmp/chrome-agent2 \
  --remote-debugging-port=9224 \
  "$AGENT2_URL" >>"$LOG" 2>&1 &

# X Space Chrome for @swarminged
PULSE_SINK=swarming_playback PULSE_SOURCE=x_swarming_mic DISPLAY=:99 \
  $CHROME "${BASE_FLAGS[@]}" \
  --user-data-dir=/tmp/chrome-swarming \
  --remote-debugging-port=9223 \
  about:blank >>"$LOG" 2>&1 &

# X Space Chrome for @eplus
PULSE_SINK=eplus_playback PULSE_SOURCE=x_eplus_mic DISPLAY=:99 \
  $CHROME "${BASE_FLAGS[@]}" \
  --user-data-dir=/tmp/chrome-eplus \
  --remote-debugging-port=9225 \
  about:blank >>"$LOG" 2>&1 &

# Wait for all 4 CDP endpoints
echo "[launch] Waiting for Chrome CDP endpoints..." | tee -a "$LOG"
for port in 9222 9223 9224 9225; do
  for i in $(seq 1 30); do
    curl -sf "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && break
    sleep 1
  done
  STATUS=$(curl -s "http://127.0.0.1:$port/json/version" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Browser','?')[:40])" 2>/dev/null || echo "timeout")
  echo "[launch] CDP :$port → $STATUS" | tee -a "$LOG"
done

# ── 5. Run X Space automation ────────────────────────────────────────────
cd "$SERVER_DIR"
if [ -f "vm-automation-dual.js" ]; then
  echo "[launch] Running dual automation for $SPACE_URL..." | tee -a "$LOG"
  node vm-automation-dual.js "$SPACE_URL" 2>&1 | tee -a "$LOG"
else
  echo "[launch] WARN: vm-automation-dual.js not found — join the Space manually." | tee -a "$LOG"
fi

echo "=== launch-dual DONE — processes running in background ===" | tee -a "$LOG"
echo ""
echo "Server:   http://127.0.0.1:${PORT:-3000}/"
echo "Agent 1:  $AGENT1_URL"
echo "Agent 2:  $AGENT2_URL"
echo "Logs:     $SERVER_DIR/server.log"
echo "          $LOG"
