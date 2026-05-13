# Task: Silence Alarm + PulseAudio Route Health

## Context
The whole broadcast depends on a fragile PulseAudio routing chain:
agent Chrome → virtual sink → X Chrome (captures the sink). When that
chain breaks (sink unmuted, wrong sink-input target, X tab refreshed,
PulseAudio restarted) the operator can't tell from the dashboard — the
status badge still says `speaking`, the transcript still streams, but
nobody in the Space hears anything.

The server's `/health` endpoint already runs `pactl list short
sink-inputs && pactl list short sources` and returns a raw blob. The
dashboard prints that blob as `<pre>`. That's not actionable.

## Goal
Parse `pactl` output into a structured route table on the server. Surface
it as a labeled health panel on the dashboard with a red/green light per
hop. Fire a **silence alarm** when an agent has `status === "speaking"`
but its meter has been below 0.02 for >2 s — that's the failure mode
this whole task exists to catch.

## Why now
A Friday show went silent for 90 seconds before anyone noticed during
the most recent rehearsal (per operator notes). Detecting it from the
dashboard would have caught it in 3 seconds.

## Requirements

### Server (`server.js`)
- Replace the raw `/health` payload with a parsed structure:
  ```json
  {
    "uptime": 1234,
    "memory": 89,
    "pulse": {
      "available": true,
      "sinks":     [ { "index": 0, "name": "virt_agent_out",    "driver": "module-null-sink",    "muted": false } ],
      "sources":   [ { "index": 1, "name": "virt_agent_out.monitor" } ],
      "sinkInputs":[ { "index": 21, "client": "chrome (agent-0)", "sink": "virt_agent_out",     "muted": false, "volume": 95 } ],
      "sourceOuts":[ { "index": 14, "client": "chrome (x-tab)",   "source": "virt_agent_out.monitor" } ]
    },
    "ffmpeg": { "available": true, "version": "..." }
  }
  ```
- Parse `pactl list sink-inputs` (long form, not short) to get the
  client application names and mute state. Match clients to agents via
  process name / window title heuristics (configurable map in
  `process.env.PULSE_CLIENT_MAP` JSON or `pulse.config.json`).
- Add `POST /pulse/mute/:sinkInputIndex` and `/pulse/unmute/:sinkInputIndex`
  (gated, audited). Shell out to `pactl set-sink-input-mute <idx> <0|1>`.
- Add a `silenceWatcher`: per-agent rolling window of `audioLevel` events
  (last 2 s). When `agents[id].status === "speaking"` and max-level over
  the window is < 0.02, emit `silenceAlarm { agentId, durationMs }` and
  `auditEntry` it. Repeat at most every 5 s to avoid spam.

### Dashboard
- Replace the raw pulse `<pre>` with a route table:
  ```
  Agent 0 (Bob)   ── chrome (agent-0) ── virt_agent_out ── monitor ── chrome (x-tab)
                  ✓ unmuted, 95%        ✓ active         ✓ captured  ✓ unmuted
  ```
  Each hop is a chip with a green/red dot. Click the unmute/mute chip
  to toggle (calls `/pulse/(un)mute/:idx`).
- New top-bar indicator: 🔇 alarm icon, hidden by default. Appears red
  and pulsing on `silenceAlarm`. Shows the agent name and elapsed
  silence. Clears when meter recovers.
- Browser notification (`Notification.requestPermission` on first load)
  so operator gets pinged even when dashboard tab is backgrounded.
- "Pulse unavailable" state (Codespaces) renders the panel as a muted
  "n/a — pactl not on this host" with the existing graceful copy.

## Files to modify / create
- `server.js`
- `pulse.config.json.example` (new — sample client-map)
- `.gitignore` (add `pulse.config.json` if real instances live on the VM)
- `public/dashboard.html`
- `public/dashboard.css`
- `public/dashboard.js`

## How to verify
1. On the VM, with the real two-agent broadcast running, open the
   dashboard. Health panel shows the agent → virt-sink → X-tab chain
   with all green dots.
2. SSH and run `pactl set-sink-input-mute <agent-sink-input> 1`. Within
   2 s, dashboard shows the unmuted hop red. Click it — runs unmute,
   green again, audit log records the toggle.
3. Force silence: kill the agent Chrome tab while it's mid-speech.
   Within 2 s, `silenceAlarm` fires, top bar shows the alarm, browser
   notification shown. Restart the tab — alarm clears.
4. In a Codespace (no pactl): dashboard health panel shows the
   graceful "pactl not available" state, no errors in console.

## Out of scope
- Configuring the PulseAudio sinks themselves. Those are set up by the
  VM image / systemd units, not by this server.
- Auto-recovery (the dashboard alerts; humans fix). A separate task
  could add auto-restart of the agent tab via the existing puppeteer
  `/x-tab-url` endpoint — *not here*.

## Gotchas
- `pactl list sink-inputs` long-form output is multi-line per entry,
  separated by blank lines. Parse with a simple split on `\n\n` then
  key:value lines. Watch out for indented "Properties:" block.
- Client-name matching is fragile. Make the matcher configurable rather
  than hardcoded. Don't crash if no client matches — render an
  "(unattributed)" row instead.
- `pactl` calls can take 200–500 ms. Don't run them on every
  `/health` request synchronously and don't run them in the silence
  watcher — pulse state can be cached for 2 s.
- The silence watcher must respect `status === "speaking"`. Otherwise
  it will alarm during normal idle time. Read state from `spaceState.agents[id].status`.
- Don't broadcast the silence alarm until the agent has been "speaking"
  for at least 500 ms. Short pauses at the start of a response are
  normal and would otherwise flap.
