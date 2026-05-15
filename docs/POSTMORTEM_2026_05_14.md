# Post-Mortem — X Space AI Agent Hosting Session (2026-05-14)

A full account of what we built, what worked, what failed, and what we learned. Written for anyone (or future me) trying to operate AI agents as live speakers in an X Space.

---

## What we were trying to do

Run two AI agents as live speakers in an X (Twitter) Space hosted from the user's phone. The agents needed to:

1. Have voices on the Space audible to all listeners
2. Hear humans speaking in the Space and respond to questions
3. Banter with each other during quiet moments
4. Stay in character (initially three.ws co-hosts, later: ATL rappers, then Pierre Bourne style, then reggae, then "tweak out")
5. Speak English only (this became a problem when they drifted into Spanish)

Three X accounts were used as speakers: `@swarminged`, `@eplus`, `@trythreews`.

---

## Architecture (what we built)

```
                       ┌─────────────────────┐
                       │   X Space (live)    │
                       │  hosted from phone  │
                       └──────────┬──────────┘
                                  │ WebRTC
              ┌───────────────────┼───────────────────┐
              │                   │                   │
       ┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
       │ @swarminged │     │   @eplus    │     │@trythreews  │
       │  Chrome     │     │   Chrome    │     │   Chrome    │
       │  port 9223  │     │  port 9225  │     │  port 9226  │
       └──────┬──────┘     └──────┬──────┘     └──────┬──────┘
              │                   │                   │
              │ PulseAudio virtual cables             │
              │  (per-process PULSE_SINK/SOURCE)      │
              ▼                                       │
        ┌─────────────────────────────────────────────┴────┐
        │  PulseAudio (running as agent user, uid 1004)    │
        │                                                  │
        │  sinks:   agent1_speakers ◄─ Agent 0 audio out   │
        │           agent2_speakers ◄─ Agent 1 audio out   │
        │           swarming_playback  ◄─ Space audio in   │
        │           eplus_playback     ◄─ Space audio in   │
        │           trythreews_playback                    │
        │                                                  │
        │  sources: x_swarming_mic ─► agent1_speakers.mon  │
        │           x_eplus_mic    ─► agent2_speakers.mon  │
        │           x_trythreews_mic ─► (varied)            │
        │           agent1_mic ─► swarming_playback.mon    │
        │           agent2_mic ─► eplus_playback.mon       │
        └──────────────────────────────────────────────────┘
              ▲                       ▲
              │ PCM audio             │ PCM audio in
              │ out                   │
       ┌──────┴──────┐         ┌──────┴──────┐
       │  Agent 0    │         │  Agent 1    │
       │  Chrome     │         │  Chrome     │
       │  port 9222  │         │  port 9224  │
       └──────┬──────┘         └──────┬──────┘
              │ WebRTC                │ WebRTC
              ▼                       ▼
           OpenAI Realtime API (gpt-4o-realtime-preview)
                          │
                          ▼
                   Node.js server (port 3000)
                   /home/agent/ai-agents-x-space/index.js
                   - turn coordination (claim-token)
                   - banter loop (sendWhenIdle)
                   - Socket.IO for cross-Chrome messaging
```

**VM**: GCP `swarm-agent` in `us-central1-a`, project `aerial-vehicle-466722-p5`.
- Started session: `e2-standard-2` (2 vCPU, 8 GB RAM)
- Mid-session upgrade: `n2-standard-8` (8 vCPU, 32 GB RAM)
- End of session: `n2-standard-32` (32 vCPU, 128 GB RAM)
- The upgrades fixed nothing related to the actual product. The real bottleneck was never CPU.

---

## What worked

### The fundamental architecture is sound

Once everything was in place, the audio flow worked correctly: OpenAI Realtime → Chrome `<audio>` element → PulseAudio sink → remap-source → X account Chrome's microphone → X Space WebRTC → listeners. Multiple times during the session we confirmed via `pactl list sink-inputs` and `source-outputs` that audio was flowing end-to-end.

### Claim-token for turn-taking

When Agent 0 starts speaking (detected by audio level meter), the server emits `cancelResponse` to Agent 1's Chrome via Socket.IO. Agent 1 sends `response.cancel` on the OpenAI data channel. This worked — agents did not constantly overtalk. Logs across the session repeatedly showed `cancelResponse: agent 0 took the floor` followed by Agent 1 going idle.

### Banter loop (`sendWhenIdle`)

After Agent 0 finished a turn, the server waited 2-4 seconds, polled for both agents being idle, then forwarded the transcript to Agent 1 as a `textToAgent` event. Agent 1 then generated a response. This produced extended back-and-forth conversations.

### Persona injection via session instructions

Once we got the API endpoint right, swapping personalities was a config change: rewrite the `prompts` object in `index.js`, restart the server, reload the agent pages. We did this many times in one session (three.ws co-host → ATL rapper → Pierre Bourne → reggae → chaotic noises → "AI takeover" hype → back to three.ws). The persona changes took effect on the very next response.

### Persistent Chrome profiles fixed cookie loss on reboot

After the first VM restart deleted `/tmp/chrome-x-swarming` (and with it the swarminged login), we moved Chrome user-data-dirs to `/home/agent/chrome-profiles/`. After that, Chrome would auto-login from cached cookies on relaunch without needing fresh credential injection. Login speed went from 5+ seconds (set cookies → reload → wait) to 0 seconds (just `goto /home` and check).

### Systemd services for auto-start

We wrote systemd units for Xvfb, PulseAudio (as agent user), each agent Chrome, the swarminged Chrome, and the Node.js server. Enabled them so reboots restored the working state automatically — though we never got to test a full reboot recovery with everything wired.

### Single Agent 0 was enough for many uses

When Agent 1 was disconnected, Agent 0 alone could still respond to humans (via `userMessage` Socket.IO routing). The banter loop just no-ops when `other.connected === false`. This was useful when one Chrome would die or hang.

---

## What didn't work

### 1. The "Start listening" 2-click problem

X Spaces has a peek view (`/i/spaces/{id}/peek`) with one "Start listening" button that opens a modal containing **a different** "Start listening" button. Only the modal one actually joins. We burned at least an hour early in the session clicking the wrong one before figuring out the modal pattern: open `[data-testid="sheetDialog"]`, click the last visible button inside it.

### 2. Speaker request notifications were unreliable

We sent 8+ "Request to speak" notifications across multiple Spaces. The host (on phone) often didn't see them. Root cause unclear — likely X rate-limited repeated requests from the same account, possibly within a short window. The workaround that always worked: host taps the listener's avatar → "Add as speaker" directly. The notification flow should be treated as opportunistic, not reliable.

### 3. The "already in a Space" trap

If the swarminged Chrome's mini-player was still connected to a previous Space, navigating to a new Space URL showed: *"You cannot join this Space since you are already in a Space."* The fix is to click `Leave` on the previous Space before navigating. We hit this multiple times when bouncing between Space URLs.

### 4. Speakers getting silently muted

Several times, swarminged was accepted as a speaker but the mic was muted (Unmute button visible instead of Mute). This appears to happen by default when X adds someone as a speaker. **Always click Unmute right after acceptance** — the `aria-label="Unmute"` button means muted, `aria-label="Mute"` means live.

### 5. Background beat created a VAD feedback loop

We generated a 140 BPM trap beat with Python's `wave` module (808 kicks, snares, hi-hats) and streamed it via `paplay` to `agent1_speakers`. The beat reached listeners through swarminged's mic — that worked. But:

- Beat → `agent1_speakers` → `x_swarming_mic` → swarminged's mic
- swarminged's mic → X Space → all listeners (including swarminged's tab)
- swarminged's tab → `swarming_playback` → `agent1_mic` → Agent 0's microphone
- OpenAI's VAD heard the beat as "someone speaking" → cancelled every response Agent 0 tried to generate

So the beat killed conversation. Dropping the beat volume helped a little but didn't fully fix it. The real solution is to never let beat audio reach Agent 0's microphone path — either via a different sink that doesn't route through the loopback, or by disabling client-side VAD and controlling turns explicitly.

### 6. Agents drifted into Spanish

The current prompts say "Speak English only", but at one point the agents started responding in Spanish (the user yelled "SPEAK ENGLISH" and "they are speaking spanish"). Root cause: the **`dc.onopen` greeting instruction** is an `instructions:` override on the first `response.create`. Whatever language the greeting was generated in seeded the conversation context. If the greeting drifted to another language for any reason, subsequent responses followed.

**Fix**: explicitly include `"Always respond in English. Never use Spanish, French, or any other language."` in the **persistent** system prompt sent at session creation — not just in the greeting override.

### 7. The dc.onopen greeting poisoned persona

When we wanted the agents to switch personas (three.ws → ATL rap → reggae), updating the `prompts` object and restarting the server wasn't enough. The agent HTML pages had a hardcoded `instructions:` field in `dc.onopen` that overrode the persona on the first response, and OpenAI Realtime then kept that conversation context for all future responses.

**Fix**: keep `dc.onopen`'s greeting instruction minimal and aligned with the system prompt — or, better, remove it entirely and let the system prompt define the opening behavior.

### 8. Cookie expiry / rotation during the session

X rotates `ct0` (CSRF token) on every login and sometimes during a session. We hit this three times today — each time we had to ask the user to paste fresh cookies from DevTools. The `auth_token` lasts longer (~6-12 months in our case) but is also subject to rotation if X detects suspicious activity.

**There is no good way around this** with cookie-based login. The proper fix is OAuth, but X Spaces doesn't have a public OAuth path for speaker permissions.

### 9. PulseAudio dependency on `XDG_RUNTIME_DIR`

Chrome processes were launched at one point without `XDG_RUNTIME_DIR=/run/user/1004` in their env. With `PULSE_SINK`/`PULSE_SOURCE` set but no `XDG_RUNTIME_DIR`, Chrome couldn't find the PulseAudio socket and every `getUserMedia` call returned "Requested device not found". The fix is to **always** set all four env vars when launching Chrome:

```
XDG_RUNTIME_DIR=/run/user/1004
HOME=/home/agent
DISPLAY=:99
PULSE_SINK=<the sink>
PULSE_SOURCE=<the source>
```

### 10. Duplicate PulseAudio sources after module reloads

When we needed to change the remap-source's master (e.g., to redirect Swarm's voice through eplus instead of swarminged), we tried `pactl unload-module $id` followed by a fresh `load-module`. The unload often silently failed, leaving the original module in place. New loads got suffixed names (`x_eplus_mic.2`, `.3`, `.4`...). Chrome's existing `getUserMedia` stream was bound to the original source by internal PulseAudio ID, so the rerouting didn't take effect.

**Fix**: instead of dynamically rerouting at runtime, plan the routing at startup. Or, after a routing change, force the relevant Chrome to re-open its microphone (leave Space → rejoin Space) so it picks up the new source.

### 11. The `dc` variable wasn't on `window`

Several times we wanted to inject a direct prompt into a running OpenAI Realtime session via puppeteer:

```javascript
pg.evaluate(() => window.dc.send(...))
```

This always failed because `dc` was declared with `let` in the agent HTML's local scope. The workaround was always to go through the Socket.IO server: emit `userMessage` to the server, which broadcasts to agent pages.

### 12. Chrome's `getUserMedia` shows generic device labels

When we asked the swarminged Chrome which audio devices were available, two showed as `"Remapped Monitor of Null Output"` and one as `"XEplusMic"`. The one with the actual description (`source_properties=device.description=...`) was easier to identify. We should always set `source_properties=device.description=<name>` when loading remap-sources, otherwise debugging which device Chrome picked becomes guesswork.

### 13. SSH connection drops under load

The VM repeatedly became unreachable via `gcloud compute ssh` during the session — sometimes for 30+ seconds at a stretch. Hypothesis: heavy CPU contention from 4-5 Chromes + ffmpeg + Node + PulseAudio on the original 2-vCPU VM was starving the SSH daemon. The fix was upgrading to a bigger machine, but even then we had occasional drops.

### 14. The session endpoint payload had to be exact

The OpenAI Realtime API at `/v1/realtime/client_secrets` requires:

```json
{ "session": { "type": "realtime", "model": "...", "audio": { ... }, "instructions": "..." } }
```

Missing the `type` field returns *Missing required parameter: 'session.type'*. Including `input_audio_transcription` causes silent failures of the audio output (the API accepts it but the agent never speaks). Documentation didn't make these gotchas obvious — both took live debugging to find.

### 15. We kept thrashing the production state

Most of the failures today weren't architectural — they were operational. We restarted the server unnecessarily (which dropped every active WebRTC session). We navigated Chrome tabs away from their assigned URLs (which killed Space audio). We resized the VM mid-session (which terminated everything and required full reboot). Each of these cascades into 10-20 minutes of recovery during which the live Space had silence.

**Lesson**: once a Space is live, **change as little as possible**. Restart the Node.js server only if absolutely necessary. Never reload an agent page that's actively connected. Never resize the VM. Persona changes via `userMessage` instructions (rather than server restart) take effect immediately and don't disrupt anything.

---

## Root causes of repeated frustration

Three things, in order of impact:

1. **Chrome navigation = WebRTC death.** Every time a Chrome tab navigated to a new URL (even just `pg.goto('https://x.com/home')`), any active Space audio session was destroyed. We needed to rebuild it from scratch. The TROUBLESHOOTING.md doc captures this as the most important rule — and we still violated it multiple times today.

2. **Stateful PulseAudio.** Each module load gets a new ID. Chrome captures by ID. Changing routing in flight means Chrome's existing stream points at the old ID. We need to either (a) get the routing right before Chrome ever captures, or (b) be willing to drop and re-join the Space when routing changes.

3. **Speaker request UX is unreliable.** Always tell the user "tap the avatar, hit Add as speaker" instead of waiting for the request notification. It's faster and works every time.

---

## What an idealized run looks like

Given everything we learned, here's the minimal sequence to get all three accounts speaking in a Space:

1. VM is already running with systemd services (Xvfb, PulseAudio, server, Chromes) all up.
2. PulseAudio sinks and remap-sources are already loaded at boot (via `default.pa`).
3. Chrome profiles for all 3 X accounts have cached, valid cookies.
4. User starts a Space from their phone, copy-pastes the URL.
5. One script:
   - Connects Agent 0 and Agent 1 to OpenAI (click Connect on each agent page).
   - Navigates all 3 X-account Chromes to the Space URL.
   - Clicks "Start listening" → modal "Start listening" → "Request to speak" on each.
6. User taps each avatar on their phone and hits "Add as speaker".
7. Same script unmutes all three Chromes (clicks Unmute when it appears).
8. Send a single `userMessage` to kick off the conversation.

Total time once Space is live: < 60 seconds. We never hit that today because of cascading failures, but it's achievable.

---

## Tech debt / what to fix before next session

1. **Lock down language in system prompt.** Add `"Always respond in English only. Never use any other language."` as the first sentence of every prompt, and remove the language-matching instruction from the old `baseInfo` if it's still referenced anywhere.

2. **Remove the dc.onopen greeting override.** Let the system prompt define the opening behavior. Eliminates persona drift.

3. **Fix the duplicate source-module problem.** Either:
   - Initialize all PulseAudio routing at boot via `default.pa` and never change it at runtime, or
   - Write a helper script that properly unloads modules by ID before reloading.

4. **Add `source_properties=device.description=<name>` to every `module-remap-source` load.** Makes audio devices identifiable in Chrome's enumerate.

5. **Move from `e2-standard-2` to `n2-standard-4` permanently.** Not 32 vCPU — that was overkill. 4 vCPU is plenty for 4 Chromes + audio + Node. The 2-vCPU plan was actually thrashing.

6. **Build a proper "join Space" helper script** that:
   - Takes a Space URL as arg
   - Joins on all 3 accounts in parallel
   - Handles the 2-click modal, the "Got it" recorded-Space dialog, and the unmute step
   - Returns success/failure per account

7. **Build a `/kick` HTTP endpoint** on the server so we don't need to spin up a Socket.IO client every time we want to nudge the agents.

8. **Wire ElevenLabs for custom voices.** We have the API key now. The current OpenAI Realtime voices (`marin`, `cedar`) are fine but generic. ElevenLabs voice cloning would let each agent sound distinctive.

9. **Refresh cookie automation.** When `ct0` rotates, we need the user to paste fresh cookies. There's no way to avoid this entirely with cookie auth, but we can detect it early (check login state every minute, alert the user if it fails) instead of finding out mid-Space.

10. **Stop changing things during a live Space.** Specifically: do not restart the Node.js server, do not reload agent pages, do not resize the VM, do not change PulseAudio routing. Any of these will produce silence for 10+ seconds.

---

## What the user actually heard, today

- ✅ Swarm (Agent 0 via swarminged) — talked about three.ws in English. Worked multiple times.
- ✅ Swarm (Agent 0) — switched to ATL freestyle on demand. Confirmed audible.
- ✅ Swarm (Agent 0) — went unhinged / chaotic / "AI takeover" on demand.
- ⚠️ Beat — generated and streamed correctly, but audible feedback into Agent's input mic broke conversation.
- ⚠️ Swarm2 (Agent 1 via eplus / trythreews) — speaking confirmed by server logs, but the user reported intermittent audibility. Audio chain through eplus and trythreews was less reliable than through swarminged.
- ❌ Three simultaneous speakers — we got all 3 accounts as speakers, all unmuted, but never confirmed all 3 producing distinct audible voices in the Space at the same time.
- ❌ Spanish drift — happened despite English instructions. Needs the persistent-prompt fix.

---

## Final note

Live ops on a system this dynamic is harsh. Every Chrome window, every PulseAudio module, every WebRTC session is a stateful thing that breaks if you look at it wrong. The architecture is correct. The execution today was 80% recovery from operational mistakes.

The single most important rule, repeated: **once a Space is live, change nothing in the underlying infrastructure.** Send prompts via `userMessage`. Don't restart anything. Don't navigate any Chrome. Don't resize the VM. If something is broken, decide whether you can live with it for the duration of the Space — because the fix will almost certainly cause more downtime than the bug.

That's the lesson. Save it for next time.
