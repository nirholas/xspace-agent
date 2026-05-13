# Showtime Runbook — Two Agents in an X Space

Quick steps to get Swarm + Swarm2 talking in a live X Space.

## Pre-flight checklist (VM side)

```bash
# SSH into VM
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a

# Check server is running
systemctl status swarm-server.service
curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $(cat /home/agent/x-spaces-v2/.admin-key)" \
  http://localhost:3000/health

# Check your .env has everything
grep -E "OPENAI_API_KEY|ADMIN_API_KEY|X_AUTH_TOKEN|ELEVENLABS" /home/agent/x-spaces-v2/.env | sed 's/=.*/=***/'
```

## Step 1 — Start the Space on your phone

Open X.com → start a Space from your account (@doi or whoever is host).  
Copy the Space URL: `https://x.com/i/spaces/XXXXXXXXXXXX`

## Step 2 — Launch everything on the VM

```bash
cd /home/agent/x-spaces-v2
./vm-launch-dual.sh "https://x.com/i/spaces/XXXXXXXXXXXX"
```

This starts Xvfb, PulseAudio, the server (if not already running), and 4 Chrome instances.

## Step 3 — Watch agent pages connect

Open in browser (tunnel the port first if needed):
```bash
# Local: forward port 3000 to your laptop
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a \
  -- -L 3000:localhost:3000 -N
```

Then open:
- `http://localhost:3000/server-agent1?key=YOUR_ADMIN_KEY` — Swarm
- `http://localhost:3000/server-agent2?key=YOUR_ADMIN_KEY` — Swarm2

Both should auto-click "Connect" and show "Connected" in green within ~10 seconds.

## Step 4 — Accept speaker requests

On your phone, you'll see two speaker requests (from @swarminged and @eplus).  
Accept both.

## Step 5 — Unmute both accounts

```bash
cd /home/agent/x-spaces-v2
node automation/unmute-dual.js
```

The agents will unmute, greet the room, and start talking to each other automatically.

## Switching to ElevenLabs voices

```bash
# Stop + relaunch with ElevenLabs TTS
TTS_MODE=elevenlabs ./vm-launch-dual.sh "https://x.com/i/spaces/XXXXXXXXXXXX"
```

Or just restart Chrome with the new URL param — the server keeps running.

## Monitoring

```bash
tail -f /home/agent/x-spaces-v2/server.log
tail -f /home/agent/x-spaces-v2/launch-dual.log
```

## If agents go quiet / disconnect

```bash
# Kick Swarm to speak
curl -s -X POST http://localhost:3000/kick/0 \
  -H "Authorization: Bearer $(cat /home/agent/x-spaces-v2/.admin-key)" \
  -H "Content-Type: application/json" \
  -d '{"instructions":"Say something interesting about three.ws right now."}'

# Kick Swarm2
curl -s -X POST http://localhost:3000/kick/1 \
  -H "Authorization: Bearer $(cat /home/agent/x-spaces-v2/.admin-key)" \
  -H "Content-Type: application/json" \
  -d '{"instructions":"Jump in with your take on three.ws."}'
```

## Emergency restart (nuclear option)

```bash
pkill -f "chrome.*user-data-dir=/tmp/chrome-" 2>/dev/null || true
pkill -f "node.*server.js" 2>/dev/null || true
sleep 2
./vm-launch-dual.sh "https://x.com/i/spaces/XXXXXXXXXXXX"
```
