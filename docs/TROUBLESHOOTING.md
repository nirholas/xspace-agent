# Troubleshooting Guide

Every error we've hit and exactly how to fix it.

---

## "Failed to parse SessionDescription. Expect line: v="

**Cause**: The SDP endpoint URL is wrong, or the model name triggers the wrong API version.

**Fix**:
1. Verify the SDP URL in `/home/agent/ai-agents-x-space/public/agent1.html` and `agent2.html`:
   ```
   CORRECT:   https://api.openai.com/v1/realtime/calls?model=gpt-4o-realtime-preview
   WRONG:     https://api.openai.com/v1/realtime?model=gpt-realtime
   WRONG:     https://api.openai.com/v1/realtime/calls?model=gpt-realtime
   ```
2. Verify the model in `/home/agent/ai-agents-x-space/index.js`:
   ```
   CORRECT:   const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview"
   WRONG:     const MODEL = "gpt-realtime"
   ```
3. Restart the server and reload agent pages.

---

## "API version mismatch. You cannot start a Realtime beta session with a GA client secret"

**Cause**: Using `/v1/realtime` (beta endpoint) with a GA ephemeral key (`ek_...`).

**Fix**: Change the SDP URL from `/v1/realtime?model=...` to `/v1/realtime/calls?model=...` in the agent HTML pages.

---

## Agents are "offline" / not connecting after clicking Connect

**Checklist**:
1. Is the server running? `curl http://localhost:3000/`
2. Does the session endpoint work? `curl http://localhost:3000/session/0` — should return JSON with a `value` key starting with `ek_`
3. Does OpenAI have credits? If the API key is out of credits, session creation silently fails or returns an error.
4. Is the SDP URL correct? (See first error above)
5. Are there browser console errors? Check the agent page's log panel via puppeteer:
   ```bash
   sudo node -e "
   const p = require('/home/agent/x-spaces-v2/node_modules/puppeteer-core');
   (async()=>{
     const b = await p.connect({browserURL:'http://127.0.0.1:9222',defaultViewport:null});
     const pg = (await b.pages())[0];
     const log = await pg.evaluate(()=>document.getElementById('logPanel')?.innerText||'no log');
     console.log(log);
     process.exit(0);
   })();
   "
   ```

---

## X account not joining Space ("Start listening" not found)

**Cause A**: Page hasn't loaded yet — timing issue.  
**Fix**: Add more wait time before clicking, or click manually via puppeteer after verifying the button exists.

**Cause B**: Cookies are expired.  
**Signs**: After clicking Start listening, nothing happens; page reloads to home; "Logged in: false" in debug output.  
**Fix**: Get fresh cookies — see [COOKIES.md](COOKIES.md).

**Cause C**: Space has ended.  
**Fix**: The host needs to have an active Space. The peek URL shows a "Start listening" button only if the Space is live.

---

## eplus not joining / "Logged in: false"

The eplus cookies expire periodically. The `auth_token` value may look the same but the `ct0` CSRF token rotates frequently.

**Fix**: 
1. Log into x.com as @eplus in Chrome
2. DevTools → Application → Cookies → x.com
3. Copy `auth_token` AND `ct0`
4. Update on VM:
```bash
sudo sed -i "s|^X_AUTH_TOKEN_EPLUS=.*|X_AUTH_TOKEN_EPLUS=NEW_VALUE|" /home/agent/automation/.env-eplus
sudo sed -i "s|^X_CT0_EPLUS=.*|X_CT0_EPLUS=NEW_VALUE|" /home/agent/automation/.env-eplus
# Also update in x-spaces-v2 if using that server
sudo sed -i "s|^X_AUTH_TOKEN_EPLUS=.*|X_AUTH_TOKEN_EPLUS=NEW_VALUE|" /home/agent/x-spaces-v2/.env
sudo sed -i "s|^X_CT0_EPLUS=.*|X_CT0_EPLUS=NEW_VALUE|" /home/agent/x-spaces-v2/.env
```

---

## Agents overtalking each other

**Cause**: The claim-token patch wasn't applied or the `cancelResponse` handler isn't firing.

**Fix**: Check `index.js` on the server for this in the `statusChange` handler:
```js
if (status === "speaking") {
  Object.values(state.agents).forEach((other) => {
    if (other.id !== agentId && other.connected && other.socketId) {
      io.to(other.socketId).emit("cancelResponse", { reason: `agent ${agentId} took the floor` })
    }
  })
}
```

And check `agent1.html`/`agent2.html` for the `cancelResponse` socket handler:
```js
socket.on("cancelResponse", () => {
  if (dc && dc.readyState === "open") {
    dc.send(JSON.stringify({ type: "response.cancel" }))
  }
})
```

---

## Agents are silent / not responding to each other

**Cause**: The `textComplete` → `sendWhenIdle` → `textToAgent` forwarder isn't in the server.

**Check** `index.js` for `sendWhenIdle` function. If missing, it needs to be patched — see `patch-claim-token.py` for reference.

**Also check**: Is the `textToAgent` handler in the agent page responding? The agent page should call `dc.send(conversation.item.create)` + `dc.send(response.create)` when it receives `textToAgent`.

---

## "Cannot find module" on server start

**Cause**: `node_modules` not installed.

**Fix**:
```bash
cd /home/agent/ai-agents-x-space
npm install --legacy-peer-deps
```

---

## Port already in use (EADDRINUSE)

**Cause**: A previous server process is still running.

**Fix**:
```bash
sudo fuser -k 3000/tcp 2>/dev/null || true
sudo pkill -f "node.*index.js" 2>/dev/null || true
sleep 2
sudo systemctl start swarm-server.service
```

---

## PulseAudio sinks missing

**Cause**: PulseAudio crashed or was restarted without loading the config.

**Check**:
```bash
pactl list short sinks | grep -E "agent1|agent2|swarming|eplus"
```

**Fix**:
```bash
pulseaudio --kill 2>/dev/null || true
sleep 1
pulseaudio --start --exit-idle-time=-1
sleep 2
pactl list short sinks  # should show 4 null sinks
```

If still missing, manually load them:
```bash
pactl load-module module-null-sink sink_name=agent1_speakers
pactl load-module module-null-sink sink_name=agent2_speakers
pactl load-module module-null-sink sink_name=swarming_playback
pactl load-module module-null-sink sink_name=eplus_playback
pactl load-module module-remap-source source_name=x_swarming_mic master=agent1_speakers.monitor
pactl load-module module-remap-source source_name=x_eplus_mic master=agent2_speakers.monitor
pactl load-module module-remap-source source_name=agent1_mic master=swarming_playback.monitor
pactl load-module module-remap-source source_name=agent2_mic master=eplus_playback.monitor
```

---

## Agent Chrome page stuck on old URL after server restart

**Cause**: Chrome is cached on the old page after a page kill/relaunch.

**Fix** (via puppeteer):
```bash
sudo node -e "
const p = require('/home/agent/x-spaces-v2/node_modules/puppeteer-core');
(async()=>{
  for(const [port,n] of [[9222,1],[9224,2]]) {
    const b=await p.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});
    const pg=(await b.pages())[0];
    await pg.goto('http://localhost:3000/agent'+n,{waitUntil:'domcontentloaded'});
    console.log('Agent'+n+':',await pg.url());
  }
  process.exit(0);
})();
"
```

---

## SSH connection drops during long commands

This happens with IAP tunnel + long-running commands. The command often completes on the VM even if SSH drops.

**Workarounds**:
- Use `run_in_background: true` for SSH commands > 30s
- Use `nohup` + log files: `nohup node script.js >> out.log 2>&1 &`
- Check results after reconnecting: `tail /home/agent/whatever.log`

---

## "Permission denied" on /home/agent/ files

The `gcloud compute ssh` connects as `codespace` user, not `agent`. Use `sudo` for all file operations on agent's home.

```bash
# Wrong:
cd /home/agent/x-spaces-v2  # Permission denied

# Right:
sudo ls /home/agent/x-spaces-v2
sudo -u agent bash -c 'cd /home/agent/x-spaces-v2 && node server.js'
```

---

## gcloud not found in Codespace

```bash
export PATH="$PATH:/home/codespace/google-cloud-sdk/bin"
```

Add this to every Bash command that uses gcloud.

---

## OpenAI API credits exhausted

The Realtime API is expensive (~$0.06/min per session). Signs:
- Session endpoint returns an error or `client_secret` is missing
- Agent page log shows connection timeout or 401 error
- `curl http://localhost:3000/session/0` returns an error JSON

**Fix**: Top up OpenAI credits at platform.openai.com → Billing.

---

## ElevenLabs TTS not working

Signs: `/tts/0/stream` returns 401 or 500.

**Check**:
```bash
grep ELEVENLABS /home/agent/ai-agents-x-space/.env
# Verify key is set and valid
curl -sf "https://api.elevenlabs.io/v1/voices" \
  -H "xi-api-key: YOUR_KEY" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['voices']),'voices')"
```

---

## NEVER navigate Chrome tabs away from their assigned page

**This is the most important operational rule.**

| Chrome | Port | Should ALWAYS be on |
|---|---|---|
| Agent1 (Swarm) | 9222 | `http://localhost:3000/agent1` |
| Agent2 (Swarm2) | 9224 | `http://localhost:3000/agent2` |
| @swarminged | 9223 | X Space URL (once joined) |
| @eplus / @trythreews | 9225 | X Space URL (once joined) |

**Why**: X Space sessions are maintained per-tab. Navigating away drops the Space audio session. The mini-player appears briefly but navigating to a new Space URL re-triggers the join flow which may fail.

**For agent pages**: Navigating away kills the WebRTC session. The agent disconnects from OpenAI Realtime and stops speaking.

**What to do instead of navigating**:
- To check state: use `curl http://localhost:3000/state`
- To check tab URL: use `curl -sf http://127.0.0.1:9223/json`
- To interact: use `pg.evaluate()` in puppeteer WITHOUT `pg.goto()`
- To take a screenshot: `pg.screenshot()` without navigating

**If a Chrome needs to join a new Space URL**:
- Navigate there ONCE
- Click "Start listening" 
- Click "Request to speak"
- Then NEVER navigate it again until the Space ends

**If a Chrome was accidentally navigated away**:
- Check if the mini-player is still active on x.com/home (check for Unmute/Mute/Leave buttons)
- If mini-player gone: re-navigate to the Space URL and re-join
- If Space ended: wait for new Space URL
