# Task: VM Runbook

## Context
The voice-broadcaster system runs on a GCP VM
(`swarm-agent` in `us-central1-a`) as a systemd service
(`swarm-server.service`). The end-to-end setup involves: PulseAudio
virtual sinks, two persistent Chrome processes (one with the agent
pages open, one logged into x.com), Cloudflared (post task `08`),
the Node server, and a handful of env vars.

When something goes wrong in production, there is **no playbook**.
Each operator triages from scratch. Tribal knowledge lives in chat
messages and untracked patch scripts.

## Goal
Produce `docs/vm-runbook.md` (or `docs/runbook.md`) — a single
markdown doc that an operator can open during an outage and follow
without prior context. It should answer:

1. How is this system put together?
2. How do I deploy a code change?
3. How do I restart cleanly?
4. What do I do when X is happening?

## Why now
The system is opaque. The author of these scripts will not always be
the on-call. This is a one-time investment that pays back the first
time someone other than the original developer has to fix something
at 11pm on a Friday.

## Required sections

### 1. Architecture diagram
ASCII or PNG (commit the .drawio or .excalidraw source). Show:
- GCP VM box with components: PulseAudio (`virt_agent_out` sink),
  Chrome A (agent pages), Chrome B (x.com tab),
  swarm-server.service, cloudflared
- External: OpenAI Realtime, ElevenLabs, X Space, Operator browser
- Arrows labeled: audio in/out, WebRTC, HTTPS, Socket.IO
- Port assignments: 3000 (Node), 9222/9223 (Chrome CDP)

### 2. Components inventory
A table listing every long-running process:

| Process | Where | How started | Logs | Restart |
|---|---|---|---|---|
| `swarm-server.service` | systemd | auto on boot | `journalctl -u swarm-server` | `sudo systemctl restart swarm-server` |
| Chrome A (agent) | systemd-user or launch script | … | `journalctl --user -u chrome-agent` | … |
| Chrome B (x-tab) | … | … | … | … |
| PulseAudio | system service | … | `journalctl --user -u pulseaudio` | … |
| cloudflared | systemd | … | `journalctl -u cloudflared` | … |

### 3. Deploy flow
Step-by-step for "push a fix from laptop to prod":
```bash
# from laptop
git push origin main

# on VM
ssh swarm-agent
cd /opt/xspace-agent
git pull
pnpm install        # only if package.json changed
sudo systemctl restart swarm-server
sudo systemctl status swarm-server   # confirm green
journalctl -u swarm-server -f -n 50  # tail until "Server bound to"
```

Include the rollback command:
```bash
git reset --hard <previous-sha>
sudo systemctl restart swarm-server
```

### 4. Pre-show checklist
A 60-second checklist the operator runs before going live:
- [ ] `pnpm preflight` returns all green (post task `09`)
- [ ] Dashboard loads, login modal works, both agents connect
- [ ] `/x-tab-url` reports the right x.com URL (logged in)
- [ ] PulseAudio: `pactl list short sink-inputs` shows Chrome A
      attached to `virt_agent_out`
- [ ] Audit log shows recent connection from your laptop IP

### 5. Incident playbook
For each known failure mode, the symptom and the fix:

| Symptom | Where to look | Fix |
|---|---|---|
| Dashboard shows "disconnected" | `journalctl -u swarm-server -n 100` | `sudo systemctl restart swarm-server` |
| Both agent badges go red mid-show | OpenAI status, then ICE state in `/alice` devtools | Wait 10s for auto-reconnect (task 11). If stuck: reload `/alice` and `/bob` |
| Listeners say audio is silent but transcript still streams | Silence alarm should fire (task 04). Otherwise: `pactl list sink-inputs` | Unmute the agent's sink-input or `pactl move-sink-input <idx> virt_agent_out` |
| OpenAI returning 429 | server log, ElevenLabs dashboard | Check Realtime quota; rotate to backup key; consider `ELEVENLABS_FALLBACK_VOICE` |
| X tab redirected to login | `curl /x-tab-url` | Cookies expired. Re-export `auth_token` and `ct0`, restart |
| Operator can't log in to dashboard | `curl /auth/info` and `/auth/check` directly | Confirm `ADMIN_API_KEY` env var; check operators.json (task 01) |
| Cloudflared unreachable | `sudo systemctl status cloudflared` | Restart; check DNS at `dashboard.yourdomain.com` |
| Server boots but binds to 127.0.0.1 only | startup log | `ADMIN_API_KEY` not set in service env. Confirm `/etc/swarm/.env` and `EnvironmentFile=` in unit |

### 6. Cron / scheduled tasks
- Are there any (currently no, but cookie rotation might want one)?
- If so: which user, which schedule, what they do, where they log.

### 7. Backup & rotation
- Where do the X cookies live? When were they last rotated?
- Where are the API keys stored on the VM (env file vs Secret Manager)?
- How is `personalities.json` (post task `06`) versioned?

### 8. Out-of-band access
- How to SSH if dashboard auth is broken (you still have the key, but
  what if the key is wrong)?
- Recovery: regenerate `ADMIN_API_KEY`, restart, log back in.

## Files to create
- `docs/vm-runbook.md` — the doc itself
- `docs/runbook-architecture.{png,drawio}` — the diagram (or the
  ASCII version inline)
- Optional: `docs/runbook-checklist.md` — pre-show checklist as a
  separate file the operator can print

## How to verify
The proof is procedural, not technical:
1. Hand the doc to someone who has never touched this system. Ask them
   to restart the server, identify the X tab's URL, and confirm both
   agents are connected. They should succeed in under 10 minutes
   following only the runbook.
2. Run through the "Both agent badges go red mid-show" entry against a
   manually disconnected agent. The fix steps work.
3. Run through the cookie-expired entry: rotate cookies on a test VM,
   confirm the runbook gets you back to a working state.

## Out of scope
- Disaster recovery (VM destroyed, region down). That's a separate
  doc.
- Detailed how-tos for each component (PulseAudio internals,
  Cloudflared install). Link to upstream docs and the relevant tasks
  in this directory (08 for tunnel, 09 for preflight, 04 for pulse).
- A staging VM setup. Useful, but not the goal here.

## Gotchas
- Don't put the actual `ADMIN_API_KEY` or X cookies in the runbook.
  Reference where they live (env file path) instead.
- Don't reference any uncommitted scripts at the repo root —
  reconcile with task `07-consolidate-patch-scripts.md` first so the
  runbook only mentions things that survive that audit.
- Test commands on the actual VM, not just locally — the
  `swarm-server.service` unit name, the path on disk, the user
  account, all need to be correct. Wrong unit names in a runbook are
  worse than no runbook.
- Keep section 5 (incident playbook) sorted by frequency, not
  alphabetical. The most common issue should be top of the list so
  operators scrolling under pressure find it first.
