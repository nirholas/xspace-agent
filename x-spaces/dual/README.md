# x-spaces/dual — Dual-Agent X Spaces Launcher

Two AI agents (Swarm + Swarm2) join the same X Space as speakers and hold a live voice conversation with each other and the audience. Each agent runs in its own Chrome profile connected to a separate X account. Audio is routed through PulseAudio virtual cables so each agent hears only the Space audio, not its own output. The agents communicate via the local Express/Socket.IO server; when one agent finishes speaking its transcript is forwarded to the other, which generates a reply.

---

## Prerequisites

- **PulseAudio** installed (`pulseaudio`, `pactl`)
- **Xvfb** installed (`xvfb-run`, or the Xvfb daemon)
- **Google Chrome** at `/usr/bin/google-chrome`
- **Node.js ≥ 18** with `puppeteer-core` available
- **`.env`** at repo root with `X_AUTH_TOKEN` + `X_CT0` (first account)
- **`.env-eplus`** at repo root with `X_AUTH_TOKEN_EPLUS` + `X_CT0_EPLUS` (second account)
- The local server running (`npm run dev` or `systemctl start swarm-server.service`)

---

## Launch Sequence

Run all commands from the **repo root**.

1. **Start the server** (if not already running via systemd):
   ```bash
   npm run dev &
   ```

2. **Apply one-time patches** (idempotent — safe to re-run):
   ```bash
   python3 x-spaces/dual/patches/two-agent-loop.py   # wire banter forwarder + agent2 greeting
   python3 x-spaces/dual/patches/agent2-respond.py   # make agent2 actually reply
   python3 x-spaces/dual/patches/transcript-events.py # fix GA Realtime event names
   python3 x-spaces/dual/patches/turn-gating.py      # prevent agents talking over each other
   ```

3. **Launch all four Chrome profiles + automation**:
   ```bash
   bash x-spaces/dual/launch.sh https://x.com/i/spaces/<SPACE_ID>
   ```
   This script:
   - Starts Xvfb on `:99` if not running
   - Configures and restarts PulseAudio with 4 virtual cables
   - Kills and recreates the four Chrome profiles
   - Launches Chrome for agent1 (port 9222), agent2 (port 9224), X-swarming (port 9223), X-eplus (port 9225)
   - Waits for all CDP endpoints to be ready
   - Runs `automation.js` to log both X tabs into the Space and request speaker for each account

4. **Accept speaker requests on your phone** — one for each account (@swarminged, @eplus).

5. **Unmute both agents**:
   ```bash
   node x-spaces/dual/unmute.js
   ```

6. **Open agent2 in the dashboard Chrome** (reload agent1, open agent2 tab, click Connect):
   ```bash
   node x-spaces/dual/open-agent2.js
   ```

7. **Update prompts** (optional — injects personality via live `session.update`):
   ```bash
   node x-spaces/dual/update-prompts.js
   ```

8. **Kick off banter** (fires `response.create` on agent1 to start the conversation):
   ```bash
   node x-spaces/dual/kick-loop.js
   ```

---

## What Each Script Does

| Script | Purpose |
|--------|---------|
| `launch.sh` | Full bootstrap: Xvfb → PulseAudio → 4× Chrome → `automation.js` |
| `automation.js` | Sets X cookies in both Space Chromes, navigates to the Space, clicks "Start listening" + "Request to speak" for each account |
| `unmute.js` | Clicks the unmute / "Turn on microphone" button in both X Chromes (run after host accepts speakers) |
| `open-agent2.js` | Reloads `/agent1` tab in the dashboard Chrome, opens `/agent2` in a new tab, clicks Connect on both |
| `update-prompts.js` | Sends `session.update` over each agent's Realtime data channel to apply personality prompts without reconnecting |
| `kick-loop.js` | Sends `response.create` to agent1 to start the first turn of conversation |
| `patches/` | Python scripts that hot-patch the running server and agent HTML pages (see `patches/README.md`) |

---

## Common Failure Modes

| Symptom | Check / Fix |
|---------|-------------|
| Agent stuck on "listening" / never speaks | `pactl list short sink-inputs` — verify agent Chrome's sink is `agent1_speakers` / `agent2_speakers`. Also check that the Space Chrome is playing to `swarming_playback` / `eplus_playback`. |
| `automation.js` exits — "missing cookies in env" | `.env` / `.env-eplus` not sourced, or tokens expired. Re-export cookies from browser DevTools. |
| "Request to speak" button never found | X UI changed selectors. Check the Space UI manually; update `automation.js` needle strings. |
| `unmute.js` times out (60s) | Host hasn't accepted speaker request yet, or the unmute button label changed. Wait for host approval first. |
| Agent2 never replies | Patches not applied, or `agent2-respond.py` found "already patched" but the server restarted from unpatched source. Re-run patches, then reload server. |
| Agents talk over each other | `turn-gating.py` patch not applied to the running `index.js`. Re-run it; restart server if needed. |
| CDP port not ready (launch hangs) | Chrome failed to start — check `~/chrome-agent1.log` etc. Likely `--no-sandbox` missing or Xvfb not running. |
| PulseAudio sinks missing after reboot | Re-run `launch.sh` — it rewrites `~/.config/pulse/default.pa` and restarts PulseAudio each time. |

---

## Cleanup

```bash
# Kill Chrome profiles
pkill -f "chrome.*user-data-dir=/tmp/chrome-" || true

# Kill PulseAudio (it will auto-restart on next use)
pulseaudio --kill || true

# Remove stale Chrome profiles
rm -rf /tmp/chrome-agent1 /tmp/chrome-agent2 /tmp/chrome-x-swarming /tmp/chrome-x-eplus

# Stop server
sudo systemctl stop swarm-server.service   # if running via systemd
# or kill the npm dev process manually
```

---

## PulseAudio Cable Layout

```
agent1_speakers (sink) ─→ agent1_speakers.monitor ─→ x_swarming_mic (source → Space Chrome mic)
agent2_speakers (sink) ─→ agent2_speakers.monitor ─→ x_eplus_mic    (source → Space Chrome mic)

swarming_playback (sink) ─→ swarming_playback.monitor ─→ agent1_mic (source → agent1 Chrome mic)
eplus_playback    (sink) ─→ eplus_playback.monitor    ─→ agent2_mic (source → agent2 Chrome mic)
```

Agent Chrome outputs TTS → its sink → remapped to the X tab's microphone source.
X tab plays Space audio → its sink → remapped to the agent Chrome's microphone source.
