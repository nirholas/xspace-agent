# Spec 2 — Health monitor + auto-recovery

You are building a **watchdog process** for `nirholas/xspace-agent` that runs on the same GCP VM as the agent stack and keeps it alive without operator intervention during live X Spaces.

Right now if any of the following breaks mid-Space, the operator has to SSH in and fix it:
1. A Chrome process crashes (agent or X tab)
2. PulseAudio loses a virtual cable (e.g. after a sound subsystem hiccup)
3. The OpenAI Realtime session drops and the page doesn't auto-reconnect
4. An agent goes silent unexpectedly (audio output stops, no transcript events)
5. The Node server crashes (systemd already restarts it but agents need to reconnect)
6. The X tab gets logged out / cookies expire

Build a watchdog that detects and recovers from each. Best practice: act locally, alert remotely.

## Architecture

New file: `vm/health-monitor.js`. Runs as user `agent` under its own systemd unit (`swarm-health.service`). Polls every 5 seconds. Each check is independent; one failure doesn't block others.

```
                      ┌────────────────────┐
                      │ swarm-health.service│ (this watchdog)
                      └────────┬───────────┘
                               │ checks
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                  ▼
    [chrome procs]     [pulse cables]     [realtime sessions]
       restart            recreate            re-fire Connect
       if dead              if missing            if disconnected
            │                  │                  │
            └──────────────────┼──────────────────┘
                               ▼
                       ┌──────────────────┐
                       │   alert webhook  │ (Slack/Discord/SMS)
                       └──────────────────┘
```

## Checks

```js
// vm/health-monitor.js
const checks = [
  { name: "chrome-agent1",       fn: chromeProcessAlive, args: ["/tmp/chrome-agent1"] },
  { name: "chrome-agent2",       fn: chromeProcessAlive, args: ["/tmp/chrome-agent2"] },
  { name: "chrome-x-swarming",   fn: chromeProcessAlive, args: ["/tmp/chrome-x-swarming"] },
  { name: "chrome-x-eplus",      fn: chromeProcessAlive, args: ["/tmp/chrome-x-eplus"] },
  { name: "pulse-cable-agent1",  fn: pulseSinkExists,    args: ["agent1_speakers"] },
  { name: "pulse-cable-agent2",  fn: pulseSinkExists,    args: ["agent2_speakers"] },
  { name: "pulse-cable-swarm",   fn: pulseSinkExists,    args: ["swarming_playback"] },
  { name: "pulse-cable-eplus",   fn: pulseSinkExists,    args: ["eplus_playback"] },
  { name: "server-listening",    fn: tcpPortOpen,         args: [3000] },
  { name: "agent1-connected",    fn: agentStateConnected, args: [0] },
  { name: "agent2-connected",    fn: agentStateConnected, args: [1] },
  { name: "agent1-not-silent",   fn: agentRecentlySpoke,  args: [0, 600] }, // last 10min
  { name: "agent2-not-silent",   fn: agentRecentlySpoke,  args: [1, 600] },
]
```

Each check returns `{ ok: boolean, detail?: string }`. The poller maintains state for each check across runs (consecutive failure count) and decides when to act:

- **First failure**: log only.
- **Second failure (10s)**: attempt auto-recovery (see below).
- **Third failure (15s) after recovery attempt**: fire alert webhook.
- **Recovery on a previously-failing check**: clear consecutive count, log "recovered".

## Auto-recovery actions

| Check | Recovery |
|---|---|
| `chrome-*` dead | `pkill -f chrome.*user-data-dir=${PROFILE}`; `rm -rf ${PROFILE}`; relaunch Chrome with same flags as `vm/launch-dual.sh` |
| `pulse-cable-*` missing | `pactl load-module module-null-sink sink_name=${NAME} ...` (re-create just that one) |
| `server-listening` down | systemd handles this; just log + alert |
| `agent*-connected` false | CDP-connect to that Chrome, click "Connect" via `automation/reconnect-agent.js` logic |
| `agent*-not-silent` false (no transcript or audio output in 10min) | Soft kick: send `response.create` via the data channel with instructions to chime in conversationally |

## Implementation details

```js
// check helpers
const { exec } = require("child_process")
const util = require("util")
const execAsync = util.promisify(exec)

async function chromeProcessAlive(profile) {
  try {
    const { stdout } = await execAsync(`pgrep -f "chrome.*user-data-dir=${profile}"`)
    return { ok: stdout.trim().length > 0 }
  } catch (e) {
    return { ok: false, detail: "pgrep returned no match" }
  }
}

async function pulseSinkExists(name) {
  try {
    const { stdout } = await execAsync(`pactl list short sinks | awk '{print $2}'`)
    return { ok: stdout.split("\n").includes(name) }
  } catch (e) {
    return { ok: false, detail: e.message }
  }
}

async function tcpPortOpen(port) {
  return new Promise((res) => {
    const sock = require("net").connect(port, "127.0.0.1", () => { sock.end(); res({ ok: true }) })
    sock.on("error", () => res({ ok: false }))
    setTimeout(() => { sock.destroy(); res({ ok: false, detail: "timeout" }) }, 1000)
  })
}

async function agentStateConnected(agentId) {
  const r = await fetch(`http://127.0.0.1:3000/state`, { headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` }})
  if (!r.ok) return { ok: false, detail: `state endpoint ${r.status}` }
  const d = await r.json()
  return { ok: !!d.agents[agentId]?.connected }
}

async function agentRecentlySpoke(agentId, secondsWindow) {
  const r = await fetch(`http://127.0.0.1:3000/state`, { headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` }})
  const d = await r.json()
  const last = d.messages.filter(m => m.agentId === agentId).pop()
  if (!last) return { ok: false, detail: "no messages from this agent yet" }
  const ageS = (Date.now() - last.timestamp) / 1000
  return { ok: ageS < secondsWindow, detail: `last message ${Math.round(ageS)}s ago` }
}
```

## Alert webhook

`process.env.HEALTH_WEBHOOK_URL` — if set, POST a JSON payload:

```json
{
  "vm": "swarm-agent",
  "timestamp": "2026-05-13T07:14:00Z",
  "level": "critical",
  "check": "chrome-x-eplus",
  "detail": "process died, auto-recovery failed after 2 attempts",
  "since": "2026-05-13T07:13:45Z"
}
```

Pre-shaped for Slack incoming webhooks (use `text` field with markdown), Discord webhooks (use `content`), and generic JSON (any field). Test with `npx --yes http-echo-server` locally.

## Self-protection

- Never restart `swarm-server.service` from this watchdog. Let systemd own its lifecycle. We only restart Chromes + recreate Pulse cables.
- Never auto-recover the same check more than **3 times in 30 minutes**. After that, alert and stop trying — something deeper is wrong.
- Log every recovery attempt to `/var/log/swarm-health.log` (rotate weekly with logrotate config in `vm/logrotate.d/swarm-health`).
- Heartbeat: log `[ok] all checks green` once per minute when everything's healthy, so operator can verify the watchdog itself isn't dead.

## systemd unit

`vm/swarm-health.service`:

```ini
[Unit]
Description=x-spaces health watchdog
After=network.target swarm-server.service
PartOf=swarm-server.service

[Service]
Type=simple
User=agent
WorkingDirectory=/home/agent/x-spaces-v2
EnvironmentFile=/home/agent/x-spaces-v2/.env
ExecStart=/usr/bin/node /home/agent/x-spaces-v2/vm/health-monitor.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/home/agent/health.log
StandardError=append:/home/agent/health.log

[Install]
WantedBy=multi-user.target
```

Wire it into `vm/setup.sh` (idempotent: detect if already installed).

## Operator CLI

`vm/health-status.js` — prints a one-screen status for ops:

```bash
$ sudo -u agent node /home/agent/x-spaces-v2/vm/health-status.js
chrome-agent1        OK   (pid 4521, 12m uptime)
chrome-agent2        OK   (pid 4522, 12m uptime)
chrome-x-swarming    OK   (pid 4523, 12m uptime)
chrome-x-eplus       DEAD (auto-recovery scheduled in 4s)
pulse-cable-agent1   OK
pulse-cable-agent2   OK
pulse-cable-swarm    OK
pulse-cable-eplus    OK
server-listening     OK   (port 3000)
agent0-connected     OK
agent1-connected     OK
agent0-not-silent    OK   (last spoke 14s ago)
agent1-not-silent    WARN (last spoke 187s ago — within tolerance)
```

## Test plan

1. Run `pkill -f "user-data-dir=/tmp/chrome-x-eplus"`. Within 10 s the watchdog should log `chrome-x-eplus DEAD → recovery attempt 1` and within 20 s the Chrome process should be alive again.
2. Run `pactl unload-module $(pactl list short modules | grep agent2_speakers | awk '{print $1}')`. Within 10 s the cable should be recreated.
3. Disconnect an agent via CDP (`dc.send({type:"session.close"})`). Watchdog should re-click Connect on that page.
4. Set `HEALTH_WEBHOOK_URL=http://localhost:8888/`, run `nc -lk 8888` in another shell. Force an alert (3+ failures). Confirm the webhook payload arrives.
5. Set `HEALTH_WEBHOOK_URL` to a real Slack incoming webhook and verify formatting renders.

## Don'ts

- Don't poll faster than every 2 seconds. CDP / pactl shouldn't be hammered.
- Don't write recovery actions that themselves need the watchdog to be running (no circular dependency).
- Don't take destructive actions (e.g. `rm -rf`) outside of `/tmp/chrome-*` profile dirs.
- Don't store the `ADMIN_API_KEY` anywhere other than the `EnvironmentFile`. Logs must never include it.

## When done

PR title: `feat(spec-2): health monitor watchdog`. PR body: a list of every recovery action implemented, the 5 test outcomes, and a screenshot of `health-status.js` output during a simulated failure.
