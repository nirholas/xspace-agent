# Runbook — Hosting an X Space

Step-by-step from zero to agents speaking. Every command is copy-pasteable.

## Prerequisites

- VM `swarm-agent` running on GCP (zone: us-central1-a, project: aerial-vehicle-466722-p5)
- OpenAI API key with Realtime API access (check billing — this burns credits fast)
- X accounts @swarminged and @eplus with valid cookies in the VM's .env files
- Active X Space started from your phone (@doi or whoever is host)

---

## Step 0 — SSH into the VM

```bash
export PATH="$PATH:/home/codespace/google-cloud-sdk/bin"
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a
```

---

## Step 1 — Start Xvfb (virtual display)

```bash
if ! pgrep -f "Xvfb :99" > /dev/null; then
  Xvfb :99 -screen 0 1280x800x24 -ac +extension RANDR &
  sleep 1
fi
export DISPLAY=:99
echo "Xvfb: $(pgrep -f 'Xvfb :99' && echo UP || echo DOWN)"
```

---

## Step 2 — Start PulseAudio

```bash
pulseaudio --kill 2>/dev/null || true
sleep 1
pulseaudio --start --exit-idle-time=-1
sleep 2
# Verify all 4 sinks exist
pactl list short sinks | grep -E 'agent1_speakers|agent2_speakers|swarming_playback|eplus_playback'
```

If any sink is missing, check `/home/agent/.config/pulse/default.pa` — see SETUP_FROM_SCRATCH.md.

---

## Step 3 — Start the server

```bash
sudo systemctl start swarm-server.service
sleep 3
# Verify
curl -sf http://localhost:3000/ -o /dev/null -w 'Server: HTTP %{http_code}\n'
```

Or run manually (useful to see logs):
```bash
cd /home/agent/ai-agents-x-space
node index.js
```

---

## Step 4 — Launch 4 Chrome instances

```bash
export DISPLAY=:99
CHROME=/usr/bin/google-chrome
FLAGS="--no-sandbox --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --no-default-browser-check --no-first-run --disable-features=MediaRouter"

# Kill any old agent Chromes
pkill -f "chrome.*user-data-dir=/tmp/chrome-agent" 2>/dev/null || true
sleep 1
rm -rf /tmp/chrome-agent1 /tmp/chrome-agent2

# Agent 1 Chrome (Swarm — WebRTC session)
PULSE_SINK=agent1_speakers PULSE_SOURCE=agent1_mic DISPLAY=:99 \
  $CHROME $FLAGS --user-data-dir=/tmp/chrome-agent1 --remote-debugging-port=9222 \
  http://localhost:3000/agent1 >> /home/agent/chrome-agent1.log 2>&1 &

# Agent 2 Chrome (Swarm2 — WebRTC session)
PULSE_SINK=agent2_speakers PULSE_SOURCE=agent2_mic DISPLAY=:99 \
  $CHROME $FLAGS --user-data-dir=/tmp/chrome-agent2 --remote-debugging-port=9224 \
  http://localhost:3000/agent2 >> /home/agent/chrome-agent2.log 2>&1 &

# X Space Chrome for @swarminged (if not already running)
if ! curl -sf http://127.0.0.1:9223/json/version >/dev/null 2>&1; then
  rm -rf /tmp/chrome-swarming
  PULSE_SINK=swarming_playback PULSE_SOURCE=x_swarming_mic DISPLAY=:99 \
    $CHROME $FLAGS --user-data-dir=/tmp/chrome-swarming --remote-debugging-port=9223 \
    about:blank >> /home/agent/chrome-swarming.log 2>&1 &
fi

# X Space Chrome for @eplus (if not already running)
if ! curl -sf http://127.0.0.1:9225/json/version >/dev/null 2>&1; then
  rm -rf /tmp/chrome-eplus
  PULSE_SINK=eplus_playback PULSE_SOURCE=x_eplus_mic DISPLAY=:99 \
    $CHROME $FLAGS --user-data-dir=/tmp/chrome-eplus --remote-debugging-port=9225 \
    about:blank >> /home/agent/chrome-eplus.log 2>&1 &
fi

# Wait for CDP endpoints to be ready
for port in 9222 9223 9224 9225; do
  for i in $(seq 1 20); do
    curl -sf http://127.0.0.1:$port/json/version >/dev/null 2>&1 && echo ":$port ready" && break
    sleep 1
  done
done
```

---

## Step 5 — Connect agent pages to OpenAI Realtime

Run this script (it clicks "Connect" on both agent pages):

```bash
sudo node -e "
const p = require('/home/agent/x-spaces-v2/node_modules/puppeteer-core');
(async()=>{
  for (const [port,name] of [[9222,'Swarm'],[9224,'Swarm2']]) {
    const b = await p.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});
    const pg = (await b.pages())[0];
    const res = await pg.evaluate(()=>{
      const btn=document.getElementById('connectBtn');
      if(btn&&!btn.disabled){btn.click();return 'clicked';}
      return 'already connected or error: '+(btn?btn.textContent:'no btn');
    });
    console.log(name+':',res);
  }
  process.exit(0);
})();
"
```

**Wait ~5 seconds**, then verify:
```bash
curl -sf http://localhost:3000/state | python3 -c "
import sys,json; s=json.load(sys.stdin)
for id,a in s['agents'].items():
    print(f'Agent {id} ({a[\"name\"]}): {a[\"status\"]} | connected: {a[\"connected\"]}')
"
```

Both agents should show `connected: True`.

---

## Step 6 — Join the Space with both X accounts

Start your Space on phone. Copy the URL (e.g. `https://x.com/i/spaces/1PKqrELveOnGb`).

```bash
# Save your Space URL
SPACE_URL="https://x.com/i/spaces/XXXXXXXXXX"

sudo node /home/agent/automation/vm-automation-dual.js "$SPACE_URL"
```

This clicks "Start listening" and "Request to speak" on both @swarminged and @eplus.

**On your phone**: You'll see 2 pending speaker requests. Accept both.

---

## Step 7 — Unmute both accounts

After accepting on phone, run:

```bash
sudo sh -c "cd /home/agent/automation && node unmute-dual.js"
```

This polls for the Unmute button on both X Chrome tabs and clicks it.

---

## Step 8 — Kick agents to start talking

The agents should auto-greet on WebRTC connect. If they're silent:

```bash
# Kick Swarm to speak
curl -X POST http://localhost:3000/kick/0 \
  -H "Content-Type: application/json" \
  -d '{"instructions":"Say hello to the Space and introduce three.ws in 1-2 sentences."}'

# Kick Swarm2 to respond
curl -X POST http://localhost:3000/kick/1 \
  -H "Content-Type: application/json" \
  -d '{"instructions":"React to what Swarm just said. Keep it short."}'
```

---

## Step 9 — Monitor

```bash
# Watch server logs live
tail -f /home/agent/ai-agents-x-space/server.log

# Check agent status
watch -n 5 'curl -sf http://localhost:3000/state | python3 -m json.tool | head -20'

# Check PulseAudio audio is flowing
pactl list short sink-inputs  # should show Chrome processes
```

---

## Quick restart (something broke)

```bash
# Nuclear option — kill everything and start fresh
pkill -f "chrome.*user-data-dir=/tmp/chrome-agent" 2>/dev/null || true
pkill -f "ai-agents-x-space" 2>/dev/null || true
sleep 2
# Then repeat from Step 3
```

---

## TTS modes

**Default (OpenAI Realtime voice)**: Agent speaks via WebRTC audio track — lowest latency, voice set in session (marin for Swarm, cedar for Swarm2).

**ElevenLabs mode** (higher quality, ~500ms extra latency): Change the agent page URL to include `?tts=elevenlabs` — this sets `output_modalities: ["text"]` on the session, captures response text, POSTs to `/tts/:id/stream`, plays the returned MP3.

To use ElevenLabs: relaunch agent Chrome tabs with `http://localhost:3000/agent1?tts=elevenlabs`.
