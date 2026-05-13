#!/usr/bin/env bash
# Dual-account launcher: each agent broadcasts via its own X account.
#   chrome-agent1  -> agent1_speakers -> X-swarming mic
#   chrome-agent2  -> agent2_speakers -> X-eplus mic
#   chrome-x-swarming -> swarming_playback (Space audio for agent1)
#   chrome-x-eplus    -> eplus_playback    (Space audio for agent2)
set -euo pipefail

SPACE_URL="${1:-}"
if [ -z "$SPACE_URL" ]; then
  echo "usage: $0 <https://x.com/i/spaces/...>"; exit 1
fi

LOG="${HOME}/launch-dual.log"
echo "=== dual launch at $(date) for $SPACE_URL ===" | tee -a "$LOG"

# 1. Xvfb
if ! pgrep -f "Xvfb :99" >/dev/null; then
  Xvfb :99 -screen 0 1280x800x24 -ac +extension RANDR >>"$LOG" 2>&1 &
  sleep 1
fi
export DISPLAY=:99

# 2. Reload Pulse with 4-cable config
cat >"${HOME}/.config/pulse/default.pa" <<'PA'
.include /etc/pulse/default.pa

# Agent outputs (one cable per agent — used as the corresponding X tab's mic)
load-module module-null-sink sink_name=agent1_speakers sink_properties=device.description=Agent1Speakers
load-module module-null-sink sink_name=agent2_speakers sink_properties=device.description=Agent2Speakers

# X tab playbacks (each X tab plays Space audio to its own cable; matching agent listens)
load-module module-null-sink sink_name=swarming_playback sink_properties=device.description=SwarmingPlayback
load-module module-null-sink sink_name=eplus_playback    sink_properties=device.description=EplusPlayback

# Remap sources for cleaner per-process selection
load-module module-remap-source source_name=x_swarming_mic master=agent1_speakers.monitor source_properties=device.description=XSwarmingMic
load-module module-remap-source source_name=x_eplus_mic    master=agent2_speakers.monitor source_properties=device.description=XEplusMic
load-module module-remap-source source_name=agent1_mic     master=swarming_playback.monitor source_properties=device.description=Agent1Mic
load-module module-remap-source source_name=agent2_mic     master=eplus_playback.monitor    source_properties=device.description=Agent2Mic
PA

pulseaudio --kill 2>/dev/null || true
sleep 1
pulseaudio --start --exit-idle-time=-1 --log-target=file:"${HOME}/pulse.log"
sleep 2
pactl list short sinks | tee -a "$LOG"

# 3. Node server (systemd)
sudo systemctl start swarm-server.service || true
sleep 2

# 4. Kill any existing Chrome instances and clean profiles
pkill -f "chrome.*user-data-dir=/tmp/chrome-" 2>/dev/null || true
sleep 1
rm -rf /tmp/chrome-agent1 /tmp/chrome-agent2 /tmp/chrome-x-swarming /tmp/chrome-x-eplus

CHROME=/usr/bin/google-chrome
CHROME_FLAGS=(
  --no-default-browser-check --no-first-run
  --no-sandbox
  --use-fake-ui-for-media-stream
  --autoplay-policy=no-user-gesture-required
  --disable-features=MediaRouter
)

# 5. Launch all four Chromes
PULSE_SINK=agent1_speakers PULSE_SOURCE=agent1_mic DISPLAY=:99 \
  $CHROME "${CHROME_FLAGS[@]}" --user-data-dir=/tmp/chrome-agent1 \
  --remote-debugging-port=9222 http://localhost:3000/agent1 >>"${HOME}/chrome-agent1.log" 2>&1 &

PULSE_SINK=agent2_speakers PULSE_SOURCE=agent2_mic DISPLAY=:99 \
  $CHROME "${CHROME_FLAGS[@]}" --user-data-dir=/tmp/chrome-agent2 \
  --remote-debugging-port=9224 http://localhost:3000/agent2 >>"${HOME}/chrome-agent2.log" 2>&1 &

PULSE_SINK=swarming_playback PULSE_SOURCE=x_swarming_mic DISPLAY=:99 \
  $CHROME "${CHROME_FLAGS[@]}" --user-data-dir=/tmp/chrome-x-swarming \
  --remote-debugging-port=9223 about:blank >>"${HOME}/chrome-x-swarming.log" 2>&1 &

PULSE_SINK=eplus_playback PULSE_SOURCE=x_eplus_mic DISPLAY=:99 \
  $CHROME "${CHROME_FLAGS[@]}" --user-data-dir=/tmp/chrome-x-eplus \
  --remote-debugging-port=9225 about:blank >>"${HOME}/chrome-x-eplus.log" 2>&1 &

# Wait for all CDP endpoints
for port in 9222 9223 9224 9225; do
  for i in $(seq 1 30); do
    curl -s "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && break
    sleep 1
  done
  echo "[launch] chrome :$port ready" | tee -a "$LOG"
done

# 6. Run dual automation
set -a; . "${HOME}/automation/.env"; . "${HOME}/automation/.env-eplus"; set +a
cd "${HOME}/automation"
node vm-automation-dual.js "$SPACE_URL" 2>&1 | tee -a "$LOG"

echo "=== dual launch DONE ===" | tee -a "$LOG"
echo
echo "Now accept BOTH speaker requests on your phone (one for @swarminged, one for @eplus)."
echo "Then run:  cd ${HOME}/automation && node unmute-dual.js"
