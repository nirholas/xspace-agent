# BUILD LOG — xspace-agent dual-agent X Space setup

Last updated: 2026-05-13. Full working state documented here.

---

## What's running where

| Thing | Location | Notes |
|---|---|---|
| Node server (WORKING) | `/home/agent/ai-agents-x-space/index.js` | Port 3000. The battle-tested server. |
| Agent 1 Chrome (Swarm) | CDP :9222 | Loads `http://localhost:3000/agent1` |
| Agent 2 Chrome (Swarm2) | CDP :9224 | Loads `http://localhost:3000/agent2` |
| X Chrome (@swarminged) | CDP :9223 | PULSE_SINK=swarming_playback, SOURCE=x_swarming_mic |
| X Chrome (@eplus) | CDP :9225 | PULSE_SINK=eplus_playback, SOURCE=x_eplus_mic |
| New server (WIP) | `/home/agent/x-spaces-v2/server.js` | Port 3001. Has banter forwarder + claim-token. Use for future. |

---

## VM details

- **VM name**: `swarm-agent`
- **Zone**: `us-central1-a`
- **Project**: `aerial-vehicle-466722-p5`
- **User in home**: `/home/agent/`

### SSH
```bash
export PATH="$PATH:/home/codespace/google-cloud-sdk/bin"
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a
```

---

## How to host a Space (step by step)

### 1. Make sure Xvfb and PulseAudio are up
```bash
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  pgrep Xvfb || (Xvfb :99 -screen 0 1280x800x24 -ac +extension RANDR &)
  export DISPLAY=:99
  pulseaudio --kill 2>/dev/null; pulseaudio --start --exit-idle-time=-1
  pactl list short sinks | grep -c 'agent1_speakers'
"
```

### 2. Start the server
```bash
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  pgrep -f 'ai-agents-x-space' || sudo -u agent bash -c 'cd /home/agent/ai-agents-x-space && nohup node index.js >> server.log 2>&1 &'
  sleep 3
  curl -sf http://localhost:3000/ -o /dev/null -w 'HTTP %{http_code}'
"
```

### 3. Launch agent Chrome pages
```bash
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  export DISPLAY=:99
  CHROME=/usr/bin/google-chrome
  FLAGS='--no-sandbox --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --no-default-browser-check --no-first-run --disable-features=MediaRouter'

  pkill -f 'chrome.*user-data-dir=/tmp/chrome-agent' 2>/dev/null || true
  sleep 1
  rm -rf /tmp/chrome-agent1 /tmp/chrome-agent2

  PULSE_SINK=agent1_speakers PULSE_SOURCE=agent1_mic DISPLAY=:99 \
    \$CHROME \$FLAGS --user-data-dir=/tmp/chrome-agent1 --remote-debugging-port=9222 \
    http://localhost:3000/agent1 &

  PULSE_SINK=agent2_speakers PULSE_SOURCE=agent2_mic DISPLAY=:99 \
    \$CHROME \$FLAGS --user-data-dir=/tmp/chrome-agent2 --remote-debugging-port=9224 \
    http://localhost:3000/agent2 &
  sleep 5
  echo 'Agent1 CDP:' \$(curl -sf http://127.0.0.1:9222/json/version | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"Browser\"][:30])' 2>/dev/null)
  echo 'Agent2 CDP:' \$(curl -sf http://127.0.0.1:9224/json/version | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"Browser\"][:30])' 2>/dev/null)
"
```

### 4. Launch X Space Chromes (if not already running)
```bash
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  export DISPLAY=:99
  CHROME=/usr/bin/google-chrome
  FLAGS='--no-sandbox --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --no-default-browser-check --no-first-run --disable-features=MediaRouter'

  # Only kill/restart if not already running
  curl -sf http://127.0.0.1:9223/json/version >/dev/null 2>&1 || (
    rm -rf /tmp/chrome-swarming /tmp/chrome-eplus
    PULSE_SINK=swarming_playback PULSE_SOURCE=x_swarming_mic DISPLAY=:99 \
      \$CHROME \$FLAGS --user-data-dir=/tmp/chrome-swarming --remote-debugging-port=9223 about:blank &
    PULSE_SINK=eplus_playback PULSE_SOURCE=x_eplus_mic DISPLAY=:99 \
      \$CHROME \$FLAGS --user-data-dir=/tmp/chrome-eplus --remote-debugging-port=9225 about:blank &
    sleep 5
  )
  echo 'Swarming CDP:' \$(curl -sf http://127.0.0.1:9223/json/version | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"Browser\"][:25])' 2>/dev/null)
  echo 'Eplus CDP:' \$(curl -sf http://127.0.0.1:9225/json/version | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"Browser\"][:25])' 2>/dev/null)
"
```

### 5. Join the Space + request to speak
Start your Space on your phone first. Get the Space URL (e.g. `https://x.com/i/spaces/1PKqrELveOnGb`).

Run the automation script (it's at `/home/agent/automation/vm-automation-dual.js` on the VM):
```bash
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo sh -c 'cd /home/agent/automation && node vm-automation-dual.js \"YOUR_SPACE_URL\"'
"
```

### 6. Accept speaker requests on phone
In the X Space on your phone, two pending speaker requests will appear. Accept both.

### 7. Unmute both accounts
```bash
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo sh -c 'cd /home/agent/automation && node unmute-dual.js'
"
```

### 8. Kick agents to start talking
```bash
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo node -e \"
const p = require('/home/agent/x-spaces-v2/node_modules/puppeteer-core');
(async()=>{
  for (const port of [9222]) {  // kick agent 0 (Swarm); it kicks agent 1 via forwarder
    const b = await p.connect({browserURL:'http://127.0.0.1:'+port});
    const pg = (await b.pages())[0];
    await pg.evaluate(() => {
      // Trigger kick via server
      fetch('/kick/0', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({})});
    });
  }
  process.exit(0);
})();
\"
"
```

Or use the curl kick endpoint:
```bash
curl -X POST http://localhost:3000/kick/0 \
  -H "Authorization: Bearer YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instructions":"Start talking about three.ws now."}'
```

---

## Cookies — how to refresh

Cookies expire. When an account stops working (buttons don't click, or "Logged in: false"):

**Get fresh cookies:**
1. Open Chrome on your Mac/PC
2. Log into x.com as the account (@swarminged or @eplus)
3. Open DevTools → Application tab → Cookies → https://x.com
4. Copy `auth_token` and `ct0`

**Update on VM:**
```bash
# For swarminged:
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo sed -i 's/^X_AUTH_TOKEN=.*/X_AUTH_TOKEN=NEW_TOKEN/' /home/agent/ai-agents-x-space/.env
  sudo sed -i 's/^X_CT0=.*/X_CT0=NEW_CT0/' /home/agent/ai-agents-x-space/.env
"

# For eplus:
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo sed -i 's/^X_AUTH_TOKEN_EPLUS=.*/X_AUTH_TOKEN_EPLUS=NEW_TOKEN/' /home/agent/automation/.env-eplus
  sudo sed -i 's/^X_CT0_EPLUS=.*/X_CT0_EPLUS=NEW_CT0/' /home/agent/automation/.env-eplus
"
```

---

## PulseAudio routing (the virtual audio cables)

```
Agent 1 Chrome (Swarm)    → SINK: agent1_speakers    (Swarm's voice OUTPUT)
                           → SOURCE: agent1_mic       = swarming_playback.monitor (hears Space)

@swarminged Chrome         → SINK: swarming_playback  (Space audio IN from X)
                           → SOURCE: x_swarming_mic   = agent1_speakers.monitor (Swarm's voice → X Space mic)

Agent 2 Chrome (Swarm2)   → SINK: agent2_speakers    (Swarm2's voice OUTPUT)
                           → SOURCE: agent2_mic       = eplus_playback.monitor (hears Space)

@eplus Chrome              → SINK: eplus_playback     (Space audio IN from X)
                           → SOURCE: x_eplus_mic      = agent2_speakers.monitor (Swarm2's voice → X Space mic)
```

Config file: `/home/agent/.config/pulse/default.pa`

---

## Server architecture (the working one)

**File**: `/home/agent/ai-agents-x-space/index.js`

Key logic:
- `textComplete` → `sendWhenIdle` → `textToAgent` to other agent (banter loop, 2s delay)
- `statusChange("speaking")` → `cancelResponse` to other agent (claim-token, prevents overtalking)
- `/session/:agentId` → mints OpenAI Realtime ephemeral key
- `/tts/:agentId/stream` → ElevenLabs streaming proxy

**Agent pages**: `http://localhost:3000/agent1` and `http://localhost:3000/agent2`
- TTS toggle: `?tts=elevenlabs` or `?tts=realtime` (default)

---

## Troubleshooting

### Agents not talking to each other
```bash
# Check agent socket connections
curl http://localhost:3000/state 2>/dev/null | python3 -m json.tool | head -20
# Kick agent 0
curl -X POST http://localhost:3000/kick/0 -H "Content-Type: application/json" -d '{}'
```

### Agent page shows SDP error
Old Chrome state. Kill chrome-agent dirs and relaunch:
```bash
pkill -f 'chrome.*user-data-dir=/tmp/chrome-agent' 2>/dev/null
rm -rf /tmp/chrome-agent1 /tmp/chrome-agent2
# Then relaunch (step 3 above)
```

### X account not joining Space (cookie expired)
See "Cookies — how to refresh" above.

### Server not responding
```bash
sudo systemctl restart swarm-server.service
# If that fails, start manually:
sudo -u agent bash -c 'cd /home/agent/ai-agents-x-space && node index.js >> server.log 2>&1 &'
```

### Can't hear agents speaking
- Check PulseAudio sinks are up: `pactl list short sinks`
- Check Chrome processes have correct PULSE_SINK: `ps aux | grep chrome | grep PULSE`
- Restart PulseAudio: `pulseaudio --kill; pulseaudio --start --exit-idle-time=-1`

---

## Files you need to know

| File | Purpose |
|---|---|
| `/home/agent/ai-agents-x-space/index.js` | The working server (DO NOT DELETE) |
| `/home/agent/ai-agents-x-space/.env` | Server env (OPENAI_API_KEY, etc.) |
| `/home/agent/automation/.env` | X cookies for @swarminged |
| `/home/agent/automation/.env-eplus` | X cookies for @eplus |
| `/home/agent/automation/vm-automation-dual.js` | Join Space with both accounts |
| `/home/agent/automation/unmute-dual.js` | Unmute both accounts after accept |
| `/home/agent/.config/pulse/default.pa` | PulseAudio virtual cable config |
| `/home/agent/x-spaces-v2/` | New server (WIP — not the one in production) |
