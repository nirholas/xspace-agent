#!/usr/bin/env bash
# showtime.sh — One-command show launcher.
#
# Usage: ./scripts/showtime.sh <space-url> [options]
#
# Options:
#   --tts elevenlabs   Use ElevenLabs TTS instead of OpenAI Realtime voices
#   --no-greet         Skip the opening kick (agents won't auto-speak)
#   --dry-run          Print each step but don't execute
#   --help
#
# What it does (in order):
#   1. Preflight — env, pulse, chrome, server
#   2. Starts Xvfb, PulseAudio, Node server (idempotent)
#   3. Launches 4 Chrome instances (agent1, agent2, x-swarming, x-eplus)
#   4. Auto-connects both agent pages to OpenAI Realtime
#   5. Joins the Space on both X accounts (automation.js)
#   6. Waits for phone-side speaker acceptance, then unmutes
#   7. Kicks both agents to open with a greeting
#   8. Prints a live status URL for the dashboard
#
# Prerequisites: running on the GCP VM as user "agent".
# Env vars loaded from /home/agent/ai-agents-x-space/.env (auto-sourced).

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPTS_DIR="$REPO_ROOT/scripts"
DUAL_DIR="$REPO_ROOT/x-spaces/dual"
LOG="$HOME/showtime.log"
CHROME=/usr/bin/google-chrome

# ── colours ──────────────────────────────────────────────────────────────────
C_RESET='\033[0m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'
C_RED='\033[31m'; C_BOLD='\033[1m'; C_DIM='\033[2m'
ok()   { echo -e "${C_GREEN}✓${C_RESET}  $*"; }
warn() { echo -e "${C_YELLOW}⚠${C_RESET}  $*"; }
fail() { echo -e "${C_RED}✗${C_RESET}  $*" >&2; }
step() { echo -e "\n${C_BOLD}── $* ──${C_RESET}"; }
dim()  { echo -e "${C_DIM}   $*${C_RESET}"; }

# ── args ──────────────────────────────────────────────────────────────────────
SPACE_URL=""
TTS_MODE="realtime"
NO_GREET=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    https://x.com/i/spaces/*) SPACE_URL="$1" ;;
    --tts) shift; TTS_MODE="${1:-realtime}" ;;
    --no-greet) NO_GREET=true ;;
    --dry-run) DRY_RUN=true; warn "DRY RUN — commands printed but not executed" ;;
    --help|-h)
      sed -n '2,20p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0 ;;
    *) fail "Unknown argument: $1"; exit 1 ;;
  esac
  shift
done

if [[ -z "$SPACE_URL" ]]; then
  fail "Space URL required.  Usage: $0 <https://x.com/i/spaces/...>"
  exit 1
fi

run() {
  if $DRY_RUN; then echo -e "${C_DIM}[dry] $*${C_RESET}"; return 0; fi
  eval "$@"
}

echo "=== showtime $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
echo -e "${C_BOLD}Space: ${SPACE_URL}${C_RESET}\n"

# ── load env ─────────────────────────────────────────────────────────────────
ENV_FILE="$REPO_ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
  dim "Loaded $ENV_FILE"
else
  fail ".env not found at $ENV_FILE — aborting"
  exit 1
fi

# Check required env vars
MISSING=""
[[ -z "${OPENAI_API_KEY:-}" ]] && MISSING="$MISSING OPENAI_API_KEY"
[[ -z "${X_AUTH_TOKEN:-}" ]]   && MISSING="$MISSING X_AUTH_TOKEN"
[[ -z "${X_CT0:-}" ]]          && MISSING="$MISSING X_CT0"
[[ -z "${X_AUTH_TOKEN_EPLUS:-}" ]] && MISSING="$MISSING X_AUTH_TOKEN_EPLUS"
[[ -z "${X_CT0_EPLUS:-}" ]]    && MISSING="$MISSING X_CT0_EPLUS"
if [[ -n "$MISSING" ]]; then
  fail "Missing required env vars:$MISSING"
  fail "Check $ENV_FILE"
  exit 1
fi
ok "Environment validated"

# ── Step 1: Xvfb ─────────────────────────────────────────────────────────────
step "Step 1 — Virtual display (Xvfb :99)"
if pgrep -f "Xvfb :99" >/dev/null 2>&1; then
  ok "Xvfb already running"
else
  run "Xvfb :99 -screen 0 1280x800x24 -ac +extension RANDR >>'$HOME/xvfb.log' 2>&1 &"
  sleep 1
  pgrep -f "Xvfb :99" >/dev/null && ok "Xvfb started" || { fail "Xvfb failed to start"; exit 1; }
fi
export DISPLAY=:99

# ── Step 2: PulseAudio ───────────────────────────────────────────────────────
step "Step 2 — PulseAudio + virtual sinks"
run "pulseaudio --kill 2>/dev/null || true; sleep 1"

# Write PulseAudio config
PULSE_CONF="$HOME/.config/pulse/default.pa"
mkdir -p "$(dirname "$PULSE_CONF")"
cat > "$PULSE_CONF" <<'PA'
.include /etc/pulse/default.pa

# Per-agent virtual cables (agent speaks into this, X tab uses it as mic)
load-module module-null-sink sink_name=agent1_speakers sink_properties=device.description=Agent1Speakers
load-module module-null-sink sink_name=agent2_speakers sink_properties=device.description=Agent2Speakers

# Per-X-tab playback sinks (Space audio plays here, agent listens)
load-module module-null-sink sink_name=swarming_playback sink_properties=device.description=SwarmingPlayback
load-module module-null-sink sink_name=eplus_playback    sink_properties=device.description=EplusPlayback

# Remapped sources so each Chrome only sees what it should hear
load-module module-remap-source source_name=x_swarming_mic master=agent1_speakers.monitor source_properties=device.description=XSwarmingMic
load-module module-remap-source source_name=x_eplus_mic    master=agent2_speakers.monitor source_properties=device.description=XEplusMic
load-module module-remap-source source_name=agent1_mic     master=swarming_playback.monitor source_properties=device.description=Agent1Mic
load-module module-remap-source source_name=agent2_mic     master=eplus_playback.monitor    source_properties=device.description=Agent2Mic
PA

run "pulseaudio --start --exit-idle-time=-1 --log-target=file:'$HOME/pulse.log'"
sleep 2

# Verify sinks
MISSING_SINKS=""
for sink in agent1_speakers agent2_speakers swarming_playback eplus_playback; do
  pactl list short sinks 2>/dev/null | grep -q "$sink" || MISSING_SINKS="$MISSING_SINKS $sink"
done
if [[ -n "$MISSING_SINKS" ]]; then
  fail "PulseAudio sinks missing:$MISSING_SINKS"; exit 1
fi
ok "PulseAudio running — 4 virtual sinks active"

# ── Step 3: Node server ───────────────────────────────────────────────────────
step "Step 3 — Node server (swarm-server.service)"
if systemctl is-active --quiet swarm-server.service 2>/dev/null; then
  ok "swarm-server.service already running"
else
  run "sudo systemctl start swarm-server.service"
  sleep 3
fi

SERVER_HTTP=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo "000")
if [[ "$SERVER_HTTP" != "200" ]]; then
  fail "Server not responding (HTTP $SERVER_HTTP)"; exit 1
fi
ok "Server responding at http://localhost:3000"

# ── Step 4: Chrome instances ─────────────────────────────────────────────────
step "Step 4 — Launch Chrome instances"

TTS_SUFFIX=""
if [[ "$TTS_MODE" == "elevenlabs" ]]; then
  TTS_SUFFIX="?tts=elevenlabs"
  warn "ElevenLabs TTS mode — ensure ELEVENLABS_API_KEY is set"
fi

CHROME_FLAGS=(
  --no-default-browser-check --no-first-run
  --no-sandbox
  --use-fake-ui-for-media-stream
  --autoplay-policy=no-user-gesture-required
  --disable-features=MediaRouter
)

AGENT_KEY="${ADMIN_API_KEY:-}"
KEY_SUFFIX=""
[[ -n "$AGENT_KEY" ]] && KEY_SUFFIX="?key=${AGENT_KEY}${TTS_SUFFIX:+&tts=${TTS_MODE}}" || KEY_SUFFIX="$TTS_SUFFIX"

dim "Killing old agent Chrome instances..."
run "pkill -f 'chrome.*user-data-dir=/tmp/chrome-' 2>/dev/null || true; sleep 1"
run "rm -rf /tmp/chrome-agent1 /tmp/chrome-agent2"

# Agent 1
run "PULSE_SINK=agent1_speakers PULSE_SOURCE=agent1_mic DISPLAY=:99 \\
  $CHROME \"\${CHROME_FLAGS[@]}\" --user-data-dir=/tmp/chrome-agent1 \\
  --remote-debugging-port=9222 \\
  'http://localhost:3000/agent1${KEY_SUFFIX}' \\
  >>'$HOME/chrome-agent1.log' 2>&1 &"

# Agent 2
run "PULSE_SINK=agent2_speakers PULSE_SOURCE=agent2_mic DISPLAY=:99 \\
  $CHROME \"\${CHROME_FLAGS[@]}\" --user-data-dir=/tmp/chrome-agent2 \\
  --remote-debugging-port=9224 \\
  'http://localhost:3000/agent2${KEY_SUFFIX}' \\
  >>'$HOME/chrome-agent2.log' 2>&1 &"

# X tab for @swarminged (skip if already running)
if ! curl -sf http://127.0.0.1:9223/json/version >/dev/null 2>&1; then
  run "rm -rf /tmp/chrome-x-swarming"
  run "PULSE_SINK=swarming_playback PULSE_SOURCE=x_swarming_mic DISPLAY=:99 \\
    $CHROME \"\${CHROME_FLAGS[@]}\" --user-data-dir=/tmp/chrome-x-swarming \\
    --remote-debugging-port=9223 about:blank \\
    >>'$HOME/chrome-x-swarming.log' 2>&1 &"
else
  ok "X-swarming Chrome already running on :9223"
fi

# X tab for @eplus (skip if already running)
if ! curl -sf http://127.0.0.1:9225/json/version >/dev/null 2>&1; then
  run "rm -rf /tmp/chrome-x-eplus"
  run "PULSE_SINK=eplus_playback PULSE_SOURCE=x_eplus_mic DISPLAY=:99 \\
    $CHROME \"\${CHROME_FLAGS[@]}\" --user-data-dir=/tmp/chrome-x-eplus \\
    --remote-debugging-port=9225 about:blank \\
    >>'$HOME/chrome-x-eplus.log' 2>&1 &"
else
  ok "X-eplus Chrome already running on :9225"
fi

# Wait for all CDP endpoints
for port in 9222 9223 9224 9225; do
  label="agent1:9222 xswarming:9223 agent2:9224 xeplus:9225"
  for i in $(seq 1 30); do
    curl -s "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && break
    [[ $i -eq 30 ]] && { fail "Chrome :$port never became ready"; exit 1; }
    sleep 1
  done
  ok "Chrome :$port ready"
done

# ── Step 5: Connect agents to OpenAI Realtime ────────────────────────────────
step "Step 5 — Connect agent pages to OpenAI Realtime"
run "node -e \"
const p = require('${REPO_ROOT}/node_modules/puppeteer-core');
(async () => {
  for (const [port, name] of [[9222, 'Agent 1 (Swarm)'], [9224, 'Agent 2 (Swarm2)']]) {
    try {
      const b = await p.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null });
      const pg = (await b.pages())[0];
      const res = await pg.evaluate(() => {
        const btn = document.getElementById('connectBtn');
        if (btn && !btn.disabled) { btn.click(); return 'clicked'; }
        if (btn && btn.disabled) return 'already connected';
        return 'button not found';
      });
      console.log('[connect]', name, '->', res);
    } catch (e) { console.error('[connect]', name, 'error:', e.message); }
  }
  process.exit(0);
})();
\" 2>&1 | tee -a '$LOG'"

sleep 5  # give Realtime sessions a moment to establish

# Verify both agents connected
AGENT_STATUS=$(curl -sf http://localhost:3000/state 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
results = []
for id, a in d.get('agents', {}).items():
    results.append(f'{a.get(\"name\",\"Agent\"+id)}: {\"connected\" if a.get(\"connected\") else \"NOT CONNECTED\"} / {a.get(\"status\",\"unknown\")}')
print('; '.join(results))
" 2>/dev/null || echo "could not read /state")
ok "Agent status: $AGENT_STATUS"

# ── Step 6: Join Space on both X accounts ────────────────────────────────────
step "Step 6 — Join X Space (@swarminged + @eplus)"
run "cd '$REPO_ROOT' && node x-spaces/dual/automation.js '$SPACE_URL' 2>&1 | tee -a '$LOG'"

# ── Step 7: Accept speaker requests ──────────────────────────────────────────
echo
echo -e "${C_BOLD}${C_YELLOW}ACTION REQUIRED ↓${C_RESET}"
echo -e "  Open X on your phone and ACCEPT BOTH speaker requests"
echo -e "  (one for @swarminged, one for @eplus)"
echo
read -r -p "  Press ENTER once you've accepted both... " _

# ── Step 8: Unmute both accounts ─────────────────────────────────────────────
step "Step 8 — Unmute both X accounts"
run "node '$DUAL_DIR/unmute.js' 2>&1 | tee -a '$LOG'"
ok "Unmute done"

# ── Step 9: Initial kick ──────────────────────────────────────────────────────
if ! $NO_GREET; then
  step "Step 9 — Kick agents to open"
  KICK_AUTH=""
  [[ -n "${ADMIN_API_KEY:-}" ]] && KICK_AUTH="-H 'Authorization: Bearer ${ADMIN_API_KEY}'"

  run "curl -sf -X POST $KICK_AUTH -H 'Content-Type: application/json' \\
    -d '{\"instructions\":\"You just joined a live X Space. Introduce yourself naturally in 1-2 sentences. Keep it casual and short.\"}' \\
    http://localhost:3000/kick/0 | python3 -c \"import sys,json; d=json.load(sys.stdin); print('kick/0:', d)\""

  sleep 2

  run "curl -sf -X POST $KICK_AUTH -H 'Content-Type: application/json' \\
    -d '{\"instructions\":\"React to what your partner just said. Keep it short and natural.\"}' \\
    http://localhost:3000/kick/1 | python3 -c \"import sys,json; d=json.load(sys.stdin); print('kick/1:', d)\""
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo
echo -e "${C_GREEN}${C_BOLD}═══════════════════════════════════════${C_RESET}"
echo -e "${C_GREEN}${C_BOLD}  🎙  SHOW IS LIVE                       ${C_RESET}"
echo -e "${C_GREEN}${C_BOLD}═══════════════════════════════════════${C_RESET}"
echo
echo -e "  Dashboard:  ${C_BOLD}http://localhost:3000/dashboard${C_RESET}"
echo -e "  State API:  http://localhost:3000/state"
echo -e "  Logs:       tail -f $HOME/showtime.log"
echo -e "  Agents:     $AGENT_STATUS"
echo
echo -e "${C_DIM}  To stop:     sudo systemctl stop swarm-server.service${C_RESET}"
echo -e "${C_DIM}  Quick kick:  curl -X POST http://localhost:3000/kick/0${C_RESET}"
echo -e "${C_DIM}  Full logs:   journalctl -u swarm-server -f${C_RESET}"
echo
echo "=== showtime complete $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"
