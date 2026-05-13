# BUILD LOG — xspace-agent dual-agent X Space setup

Last updated: 2026-05-13. All session notes, decisions, and current state.

---

## Documentation index

| Doc | What's in it |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the whole system works — audio routing, banter loop, claim-token |
| [SETUP_FROM_SCRATCH.md](docs/SETUP_FROM_SCRATCH.md) | Fresh VM setup start to finish |
| [RUNBOOK.md](docs/RUNBOOK.md) | Step-by-step to host a Space (copy-paste commands) |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Every error we hit and exact fix |
| [COOKIES.md](docs/COOKIES.md) | How to get, store, and refresh X account cookies |
| [AUDIO_ROUTING.md](docs/AUDIO_ROUTING.md) | PulseAudio virtual cables explained in detail |
| [OPENAI_REALTIME_API.md](docs/OPENAI_REALTIME_API.md) | GA vs Beta, correct endpoints, model names, data channel events |
| [SHOWTIME.md](SHOWTIME.md) | Quick reference card for day-of-Space use |

---

## Current production state (2026-05-13)

### What's running on the VM

| Component | Location | Port | Status |
|---|---|---|---|
| Working server | `/home/agent/ai-agents-x-space/index.js` | 3000 | **USE THIS** |
| New server (WIP) | `/home/agent/x-spaces-v2/server.js` | 3001 | Installed but not production |
| Agent 1 Chrome | CDP :9222, loads `localhost:3000/agent1` | — | Working |
| Agent 2 Chrome | CDP :9224, loads `localhost:3000/agent2` | — | Working |
| @swarminged Chrome | CDP :9223, PULSE_SINK=swarming_playback | — | Working |
| @eplus Chrome | CDP :9225, PULSE_SINK=eplus_playback | — | Working (cookies need periodic refresh) |

### VM details

| | |
|---|---|
| VM name | `swarm-agent` |
| Zone | `us-central1-a` |
| Project | `aerial-vehicle-466722-p5` |
| SSH | `gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a` |
| gcloud path | `/home/codespace/google-cloud-sdk/bin/gcloud` |

### Environment files

| File | Contains |
|---|---|
| `/home/agent/ai-agents-x-space/.env` | `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, voices, server config |
| `/home/agent/automation/.env` | `X_AUTH_TOKEN`, `X_CT0` for @swarminged |
| `/home/agent/automation/.env-eplus` | `X_AUTH_TOKEN_EPLUS`, `X_CT0_EPLUS` for @eplus |
| `/home/agent/x-spaces-v2/.env` | Copies of all the above + `ADMIN_API_KEY` for new server |

---

## Critical configuration values

### OpenAI Realtime API (GA)

```js
// CORRECT server session endpoint
POST https://api.openai.com/v1/realtime/sessions
body: { model: "gpt-4o-realtime-preview", ... }

// CORRECT browser SDP endpoint
POST https://api.openai.com/v1/realtime/calls?model=gpt-4o-realtime-preview
Headers: Authorization: Bearer ek_...
         Content-Type: application/sdp
// NO openai-beta: realtime=v1 header

// WRONG (do not use):
// POST /v1/realtime  ← this is the BETA endpoint
// model: "gpt-realtime"  ← deprecated alias
```

### Agent voices

| Agent | Voice |
|---|---|
| Swarm (Agent 0) | `marin` |
| Swarm2 (Agent 1) | `cedar` |

### Automation file locations on VM

| Script | Location | Purpose |
|---|---|---|
| Join Space | `/home/agent/automation/vm-automation-dual.js` | CDP automation to join Space with both accounts |
| Unmute | `/home/agent/automation/unmute-dual.js` | Click Unmute on both X Chrome tabs |
| Kick loop | `/home/agent/automation/kick-loop.js` | Force agents to start talking |
| Update prompts | `/home/agent/automation/update-prompts.js` | Live system prompt update via CDP |

---

## How to get the agents talking (minimum viable steps)

```bash
export PATH="$PATH:/home/codespace/google-cloud-sdk/bin"

# 1. Verify server is up
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  curl -sf http://localhost:3000/ -o /dev/null -w 'Server: HTTP %{http_code}\n'
"

# 2. Connect agent pages (click the Connect button)
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo node -e \"
const p = require('/home/agent/x-spaces-v2/node_modules/puppeteer-core');
(async()=>{
  for(const [port,n] of [[9222,1],[9224,2]]) {
    const b=await p.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});
    const pg=(await b.pages())[0];
    const r=await pg.evaluate(()=>{const btn=document.getElementById('connectBtn');if(btn&&!btn.disabled){btn.click();return 'clicked';}return 'state:'+btn?.textContent;});
    console.log('Agent'+n+':',r);
  }
  process.exit(0);
})();
\"
"

# 3. Join Space (replace URL)
SPACE="https://x.com/i/spaces/XXXXXXX"
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo sh -c 'cd /home/agent/automation && node vm-automation-dual.js \"$SPACE\"'
"

# 4. Accept requests on phone, then unmute
gcloud compute ssh swarm-agent --tunnel-through-iap --zone=us-central1-a --command="
  sudo sh -c 'cd /home/agent/automation && node unmute-dual.js'
"
```

---

## Session history (2026-05-13)

### What was broken when we started
- OpenAI GA Realtime API migration: old code used beta endpoint `/v1/realtime` and model `gpt-realtime`
- Both wrong. GA endpoint is `/v1/realtime/calls`, model is `gpt-4o-realtime-preview`
- Agent 2 (Swarm2) was not responding to `textToAgent` events — `if (agent.AGENT_ID !== 0) return` blocked it
- No `cancelResponse` handler in agent pages — claim-token signals from server were ignored
- `textComplete` forwarder missing from new server code

### What we fixed
1. `provider-openai-realtime.js` — removed agent ID guard, both agents respond to `textToAgent`
2. `provider-openai-realtime.js` — added `cancelResponse` handler (sends `response.cancel` to OpenAI)
3. `provider-openai-realtime.js` — added greeting kick on `dc.onopen` for agent 0
4. `server.js` — added `sendWhenIdle` banter forwarder in `textComplete` handler
5. `server.js` — agent names changed to Swarm/Swarm2, voices to marin/cedar
6. `server.js` — updated system prompts to three.ws-focused, natural co-host personality
7. VM agent pages — fixed SDP URL and model name (see above)

### What's still pending
- New server at `/home/agent/x-spaces-v2/` has all fixes but isn't in production yet (model name issue fixed, needs testing after credits are replenished)
- eplus cookies need to be refreshed when `ct0` rotates

---

## Known issues + workarounds

| Issue | Cause | Fix |
|---|---|---|
| Agents offline after restart | SDP wrong endpoint or model | Check `/v1/realtime/calls?model=gpt-4o-realtime-preview` |
| SDP error "Expect line: v=" | Response was JSON error, not SDP | Usually wrong endpoint or out of credits |
| eplus not joining | Stale `ct0` cookie | Get fresh cookies from browser |
| Agents overtalking | `cancelResponse` handler missing | Check agent page has the handler |
| Agents silent after connect | Forwarder missing in server | Check server has `sendWhenIdle` in textComplete |
| `gcloud: not found` | PATH doesn't include SDK | `export PATH="$PATH:/home/codespace/google-cloud-sdk/bin"` |
| `Permission denied` on /home/agent | Wrong user (codespace, not agent) | Use `sudo` |
| Port 3000 taken | Old server still running | `sudo fuser -k 3000/tcp` |
