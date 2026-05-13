# VM Runbook — swarm-agent (GCP us-central1-a)

**Last updated:** 2026-05-13  
**Service:** `swarm-server.service`  
**Primary contact:** See `ADMIN_API_KEY` rotation section if you need access

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Components inventory](#2-components-inventory)
3. [Deploy a code change](#3-deploy-a-code-change)
4. [Pre-show checklist](#4-pre-show-checklist)
5. [Incident playbook](#5-incident-playbook)
6. [Cron and scheduled tasks](#6-cron-and-scheduled-tasks)
7. [Secrets and backup](#7-secrets-and-backup)
8. [Out-of-band access](#8-out-of-band-access)

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  GCP VM: swarm-agent  (us-central1-a)                           │
│                                                                  │
│  ┌─────────────────┐   CDP/9222   ┌──────────────────────────┐  │
│  │  Chrome A       │◄────────────►│                          │  │
│  │  (agent pages)  │              │   swarm-server.service   │  │
│  │  :9222 / :9224  │   CDP/9223   │   Node.js  port 3000     │  │
│  ├─────────────────┤◄────────────►│                          │  │
│  │  Chrome B       │              │   Socket.IO /space       │  │
│  │  (x.com tabs)   │              │                          │  │
│  │  :9223 / :9225  │              └──────────────────────────┘  │
│  └────────┬────────┘                        │ HTTP :3000         │
│           │ audio in/out                    │                    │
│  ┌────────▼────────────────────────┐        │                    │
│  │  PulseAudio virtual cables      │        ▼                    │
│  │  agent1_speakers  (sink)        │  ┌─────────────┐           │
│  │  agent2_speakers  (sink)        │  │ cloudflared │           │
│  │  swarming_playback (sink)       │  │ :443 outbound│          │
│  │  eplus_playback   (sink)        │  └──────┬──────┘           │
│  │  + remapped mic sources         │         │ HTTPS tunnel      │
│  └─────────────────────────────────┘         │                   │
│                                              │                   │
│  Xvfb :99  (virtual display for Chrome)     │                   │
└─────────────────────────────────────────────│───────────────────┘
                                              │
              ┌───────────────────────────────┼─────────────────────────┐
              │                               │                         │
              ▼                               ▼                         ▼
   ┌──────────────────┐          ┌────────────────────┐    ┌──────────────────┐
   │ OpenAI Realtime  │          │  dashboard.you     │    │  X Space (live)  │
   │ api.openai.com   │          │  domain.com        │    │  x.com/i/spaces  │
   │ WebRTC + WSS     │          │ (operator browser) │    │  WebRTC audio    │
   └──────────────────┘          └────────────────────┘    └──────────────────┘
              │
              ▼
   ┌──────────────────┐
   │ ElevenLabs TTS   │
   │ api.elevenlabs.io│
   │ HTTPS            │
   └──────────────────┘
```

**Port map:**

| Port | Service | Bound to |
|------|---------|----------|
| 3000 | Node server (HTTP + Socket.IO) | 0.0.0.0 (when `ADMIN_API_KEY` set) |
| 9222 | Chrome A — agent1 CDP | 127.0.0.1 |
| 9223 | Chrome B — x-swarming CDP | 127.0.0.1 |
| 9224 | Chrome A — agent2 CDP (dual) | 127.0.0.1 |
| 9225 | Chrome B — x-eplus CDP (dual) | 127.0.0.1 |

**Audio cable layout (dual-agent):**

```
Chrome agent1 TTS → agent1_speakers sink → agent1_speakers.monitor
                                                     ↓
                                        x_swarming_mic (remapped source)
                                                     ↓
                                        Chrome X-swarming mic input

Chrome X-swarming playback → swarming_playback sink → swarming_playback.monitor
                                                              ↓
                                               agent1_mic (remapped source)
                                                              ↓
                                               Chrome agent1 mic input
```
Agent2 / X-eplus follow the identical pattern with `agent2_speakers` and `eplus_playback`.

---

## 2. Components inventory

| Process | How started | Logs | Restart |
|---------|------------|------|---------|
| `swarm-server.service` | systemd, auto on boot | `journalctl -u swarm-server -f -n 100` | `sudo systemctl restart swarm-server` |
| Chrome A — agent pages (:9222, :9224) | `x-spaces/dual/launch.sh` | `~/chrome-agent1.log`, `~/chrome-agent2.log` | Kill and re-run `launch.sh` |
| Chrome B — x.com tabs (:9223, :9225) | `x-spaces/dual/launch.sh` | `~/chrome-x-swarming.log`, `~/chrome-x-eplus.log` | Kill and re-run `launch.sh` |
| PulseAudio | `pulseaudio --start` (via `launch.sh`) | `~/pulse.log` (if configured) | `pulseaudio --kill && pulseaudio --start --exit-idle-time=-1` |
| Xvfb :99 | `launch.sh` | inline in `~/launch-dual.log` | `pkill -f "Xvfb :99"; Xvfb :99 -screen 0 1280x800x24 -ac &` |
| cloudflared | systemd | `journalctl -u cloudflared -n 100` | `sudo systemctl restart cloudflared` |

**Quick: are all processes alive?**
```bash
sudo systemctl is-active swarm-server
sudo systemctl is-active cloudflared
pgrep -af "Xvfb :99"
pgrep -af "chrome.*user-data-dir=/tmp/chrome-"
pactl list short sinks | grep -E "agent|swarming|eplus"
```

---

## 3. Deploy a code change

### Normal deploy (from laptop to VM)

```bash
# 1. Push from your laptop
git push origin main

# 2. SSH onto the VM
ssh swarm-agent   # or: gcloud compute ssh swarm-agent --zone us-central1-a

# 3. Pull the change
cd /opt/xspace-agent        # adjust if repo lives elsewhere
git pull origin main

# 4. Install dependencies ONLY if package.json changed
#    (pnpm, not npm — see package manager note below)
pnpm install

# 5. Restart the service
sudo systemctl restart swarm-server

# 6. Confirm it came up
sudo systemctl status swarm-server
journalctl -u swarm-server -f -n 50
# Wait for: "Server bound to 0.0.0.0:3000"
```

> **Package manager:** This repo uses **pnpm** workspaces. Running `npm install` breaks the workspace layout. Always use `pnpm install`.

### Rollback

```bash
# Find the previous commit hash
git log --oneline -5

# Reset to it
git reset --hard <previous-sha>
sudo systemctl restart swarm-server
sudo systemctl status swarm-server
```

### Repo path

The repo is expected at `/opt/xspace-agent`. If you land on the VM and it isn't there:
```bash
find /home /opt -name "server.js" -maxdepth 5 2>/dev/null
```

---

## 4. Pre-show checklist

Run through this in order ~5 minutes before going live. Each step takes under 30 seconds.

- [ ] **Service is running**  
  `sudo systemctl is-active swarm-server` → should print `active`

- [ ] **Preflight passes**  
  `pnpm preflight` → all checks green (see task `09`)

- [ ] **Dashboard loads**  
  Open `https://dashboard.yourdomain.com` in your browser. The login modal should appear and accept your `ADMIN_API_KEY`.

- [ ] **Both agent tabs connected**  
  After logging in, open `/alice` and `/bob`. Both status badges should be green.

- [ ] **X tab is logged in**  
  ```bash
  curl -s -H "x-api-key: $ADMIN_API_KEY" http://localhost:3000/x-tab-url
  ```
  Should return a URL that starts with `https://x.com/i/spaces/` (not a login page).

- [ ] **PulseAudio cables routed**  
  ```bash
  pactl list short sink-inputs
  ```
  Should show Chrome processes attached to the correct sinks (not the default sink).

- [ ] **ElevenLabs character budget**  
  ```bash
  curl -s -H "x-api-key: $ADMIN_API_KEY" http://localhost:3000/metrics | grep -i elevenlabs
  ```
  Confirm `dailyCharsUsed` is well below `ELEVENLABS_DAILY_CHAR_CAP` (default 200 000).

---

## 5. Incident playbook

> Sorted by how often each issue occurs. Most common first.

### Dashboard shows "disconnected"

**Where to look:** `journalctl -u swarm-server -n 100`

**Common causes:**
- Server crashed (OOM, unhandled exception)
- Cloudflared tunnel dropped

**Fix:**
```bash
sudo systemctl restart swarm-server
sudo systemctl status swarm-server
# If that's green but dashboard still shows disconnected, check tunnel:
sudo systemctl restart cloudflared
sudo systemctl status cloudflared
```

---

### Both agent badges go red mid-show

**Where to look:** OpenAI status page (status.openai.com), then open `/alice` devtools → Console tab for ICE errors.

**Fix:**
1. Wait 10 seconds — the client auto-reconnects (task 11).
2. If still red after 30 seconds, reload the `/alice` and `/bob` pages in the operator browser.
3. If OpenAI Realtime is down site-wide, pause the show until it recovers.

---

### Listeners say audio is silent — transcript still streams

**Where to look:** Silence alarm should have fired (task 04). If not:
```bash
pactl list short sink-inputs
```
Find the Chrome process index for the X tab. It should be attached to `swarming_playback` (or `eplus_playback` for account 2).

**Fix:**
```bash
# Move the sink-input to the correct sink
pactl move-sink-input <index> swarming_playback

# Or unmute the sink-input if it's muted
pactl set-sink-input-mute <index> 0
```

---

### X tab redirected to login page mid-show

**Where to look:**
```bash
curl -s -H "x-api-key: $ADMIN_API_KEY" http://localhost:3000/x-tab-url
```
Returns a login URL → cookies expired.

**Fix:**
1. On a browser where you're logged into the X account, open DevTools → Application → Cookies → x.com.
2. Copy `auth_token` and `ct0` values.
3. On the VM:
   ```bash
   # Edit the env file — do NOT paste keys into chat or logs
   sudo nano /etc/swarm/.env
   # Update X_AUTH_TOKEN and X_CT0 (or X_AUTH_TOKEN_EPLUS / X_CT0_EPLUS for account 2)
   sudo systemctl restart swarm-server
   ```
4. Re-run `x-spaces/dual/launch.sh` to re-open the X tab with the new cookies.

---

### OpenAI returning 429 (rate limit / quota exceeded)

**Where to look:** Server log for `429` responses:
```bash
journalctl -u swarm-server -n 200 | grep -i "429\|rate.limit\|quota"
```
Also check the OpenAI usage dashboard for your key.

**Fix (short-term):**
1. Rotate to a backup key:
   ```bash
   sudo nano /etc/swarm/.env
   # Replace OPENAI_API_KEY with the backup key
   sudo systemctl restart swarm-server
   ```
2. If ElevenLabs TTS is hitting `ELEVENLABS_DAILY_CHAR_CAP`, set `ELEVENLABS_FALLBACK_VOICE` or switch `TTS_PROVIDER=openai`.

---

### Operator can't log in to the dashboard

**Where to look:**
```bash
curl -s http://localhost:3000/auth/info
# Should return: {"authRequired":true}

curl -s -X POST http://localhost:3000/auth/check \
  -H "Content-Type: application/json" \
  -d '{"key":"YOUR_KEY"}'
# Should return: {"ok":true}
```

**Fix:**
```bash
# Confirm the key is set in the env file
sudo grep ADMIN_API_KEY /etc/swarm/.env

# Confirm systemd is loading the env file
sudo systemctl cat swarm-server | grep EnvironmentFile

# If the EnvironmentFile= line is missing or path is wrong, edit the unit:
sudo systemctl edit swarm-server --full
# Add under [Service]:
# EnvironmentFile=/etc/swarm/.env
sudo systemctl daemon-reload
sudo systemctl restart swarm-server
```

---

### Server binds to 127.0.0.1 only — dashboard unreachable externally

**Where to look:** Server startup log:
```bash
journalctl -u swarm-server -n 20 | grep "bound to"
# Bad: "Server bound to 127.0.0.1:3000"
# Good: "Server bound to 0.0.0.0:3000"
```

**Root cause:** `ADMIN_API_KEY` is not set in the service environment. The server deliberately refuses to bind to 0.0.0.0 without auth.

**Fix:** Same as "Operator can't log in" above — confirm `/etc/swarm/.env` has `ADMIN_API_KEY` and the unit file has `EnvironmentFile=`.

---

### Cloudflared tunnel unreachable

**Where to look:**
```bash
sudo systemctl status cloudflared
journalctl -u cloudflared -n 50
```

**Fix:**
```bash
sudo systemctl restart cloudflared
# Check tunnel is registered
cloudflared tunnel list
# Confirm DNS: dig dashboard.yourdomain.com
```
If the tunnel ID changed, update `/etc/cloudflared/config.yml` and re-run `sudo cloudflared service install`.

---

### PulseAudio / Xvfb died — Chrome can't start audio

**Symptom:** Chrome processes launch but log "Xvfb display unavailable" or "PulseAudio connection refused".

**Fix (nuclear restart of the whole stack):**
```bash
# Kill everything
pkill -f "chrome.*user-data-dir=/tmp/chrome-" || true
pulseaudio --kill || true
pkill -f "Xvfb :99" || true
rm -rf /tmp/chrome-agent1 /tmp/chrome-agent2 /tmp/chrome-x-swarming /tmp/chrome-x-eplus

# Re-launch (re-opens all Chrome windows, re-routes PulseAudio, re-navigates to Space)
bash x-spaces/dual/launch.sh "https://x.com/i/spaces/<SPACE_ID>"
```

After the Chrome windows reopen, follow the post-launch steps in the next section.

#### After re-running launch.sh

1. Accept the "Request to speak" prompt on the X mobile apps (one per account).
2. `node x-spaces/dual/unmute.js` — unmutes both X tabs.
3. `node x-spaces/dual/open-agent2.js` — reconnects agent2 in the dashboard.
4. `node x-spaces/dual/kick-loop.js` — fires the first agent turn.

---

## 6. Cron and scheduled tasks

There are **no scheduled cron jobs** as of 2026-05-13.

Cookie rotation does not yet run automatically. When it does, it should be added here with:
- Which user account runs it (`crontab -l -u agent`)
- The schedule and script path
- Where it logs (`>> ~/cookie-rotation.log 2>&1`)

---

## 7. Secrets and backup

### Where secrets live on the VM

| Secret | Location | Set by |
|--------|----------|--------|
| `ADMIN_API_KEY` | `/etc/swarm/.env` | Operator (manual, during setup) |
| `OPENAI_API_KEY` | `/etc/swarm/.env` | Operator |
| `ELEVENLABS_API_KEY` | `/etc/swarm/.env` | Operator |
| `X_AUTH_TOKEN`, `X_CT0` | `/etc/swarm/.env` | Operator (rotate when cookies expire) |
| `X_AUTH_TOKEN_EPLUS`, `X_CT0_EPLUS` | `/etc/swarm/.env` | Operator (second X account) |

The env file is loaded by systemd via `EnvironmentFile=/etc/swarm/.env`. Permissions should be `640`, owned by `root:agent` so the service user can read it but it isn't world-readable.

**Do not put secrets in the repo, in shell history, or in chat messages.**

### When to rotate X cookies

X sessions expire roughly every 30 days. Rotate proactively before a show if you notice the last rotation was more than 3 weeks ago. Symptom of expiry: `/x-tab-url` returns a login URL.

### API key storage

Keys are stored in `/etc/swarm/.env` only. There is no integration with GCP Secret Manager yet. If you move to Secret Manager, update this section.

### personalities.json / operator config

Personality prompts are injected live via `update-prompts.js` and not persisted on disk between restarts. The canonical source is the repo (`docs/prompts/PERSONA_LIBRARY.md`). No special backup is needed.

---

## 8. Out-of-band access

### SSH when the dashboard is broken

The dashboard being down does not affect SSH access. If you have the GCP key:
```bash
gcloud compute ssh swarm-agent --zone us-central1-a
# or direct:
ssh -i ~/.ssh/gcp_key agent@<EXTERNAL_IP>
```

If the key is lost or wrong, use the GCP Console → Compute Engine → VM instances → swarm-agent → "Edit" to add a new SSH public key. No service restart required.

### Reset ADMIN_API_KEY

If the key is lost or compromised:
```bash
# On the VM via SSH
NEW_KEY=$(openssl rand -hex 32)
echo "New key: $NEW_KEY"   # copy it somewhere safe before proceeding

sudo sed -i "s/^ADMIN_API_KEY=.*/ADMIN_API_KEY=${NEW_KEY}/" /etc/swarm/.env
sudo systemctl restart swarm-server

# Verify
curl -s -X POST http://localhost:3000/auth/check \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"${NEW_KEY}\"}"
# Should return: {"ok":true}
```

Distribute the new key to all operators out-of-band (not via chat).

### If the VM itself is unresponsive

- GCP Console → Compute Engine → VM instances → swarm-agent → **Reset** (hard reboot)
- After reboot, `swarm-server.service` starts automatically (enabled via `sudo systemctl enable swarm-server`)
- Chrome and PulseAudio do **not** auto-start. Run `launch.sh` manually after SSH-ing in.

---

## Appendix: useful one-liners

```bash
# Full process status snapshot
sudo systemctl is-active swarm-server cloudflared
pgrep -af "Xvfb|pulseaudio|chrome.*user-data"

# Check server is actually listening on the right address
ss -tlnp | grep 3000

# Tail all relevant logs at once (requires tmux or multiple panes)
journalctl -u swarm-server -f &
journalctl -u cloudflared -f &
tail -f ~/chrome-agent1.log ~/chrome-x-swarming.log

# Check ElevenLabs daily usage
curl -s -H "x-api-key: $ADMIN_API_KEY" http://localhost:3000/metrics

# Check which Chrome tabs are open on port 9223 (X tab)
curl -s http://127.0.0.1:9223/json | python3 -m json.tool | grep url

# Verify PulseAudio cable routing
pactl list short sink-inputs
pactl list short sinks
pactl list short sources
```
