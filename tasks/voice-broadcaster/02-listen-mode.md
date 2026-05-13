# Task: Dashboard Listen Mode

## Context
The operator can see transcripts and audio meters, but the dashboard is
**silent**. To hear what the X Space hears, the operator currently must
keep `/alice` and `/bob` tabs open with audio playing — which forces them
to leave those tabs as the focused window and confuses Pulse routing if
they hit pause by accident.

## Goal
Add a "listen" toggle to the dashboard that plays the live agent audio
in-page, so the operator can monitor the broadcast from a single tab.
Per-agent mute toggles. Latency hint shown in the UI.

## Why now
Operating a live broadcast without hearing it is high-risk. The agent
HTML pages already produce audio locally (either WebRTC track from the
Realtime API or MP3 from `/tts/:agentId/stream` when ElevenLabs mode is
on). We need a way to forward that audio to the dashboard.

## Approach

Two TTS modes — different mechanics for each.

### A) ElevenLabs streaming mode (`?tts=elevenlabs` on the agent page)
The agent page calls `POST /tts/:agentId/stream` and gets MP3 bytes. The
server has those bytes in flight — it can fan them out to dashboard
subscribers cheaply.

Add a one-shot tap on the server side:
- New route `GET /listen/:agentId` (gated) that opens an `audio/mpeg`
  long-lived response.
- When `/tts/:agentId/stream` proxies ElevenLabs, fork the chunks to all
  active `/listen/:agentId` subscribers in addition to the original agent.
- Dashboard plays via `<audio id="listen-0" src="/listen/0?key=..." preload="none">`.

### B) OpenAI Realtime WebRTC mode (default)
The audio track lives in the agent browser tab — the server never sees
the bytes. Two options:

- **Option B1 (recommended, simpler):** in `public/js/provider-openai-realtime.js`,
  after the `MediaStreamAudioSourceNode` is wired into the meter analyser,
  also pipe it through `audioContext.createMediaStreamDestination()` and
  POST chunks via `MediaRecorder` (opus/webm, 250 ms timeslice) to a new
  socket event `agentAudioChunk { agentId, mime, chunk }`. Server fans out
  to dashboards as `listenAudio`. Dashboard plays via `MediaSource`.
- **Option B2:** a separate WebRTC peer from each agent tab to each
  dashboard tab. Cleaner audio (no transcode) but pairwise complexity.
  **Skip** unless B1 latency is unacceptable.

Implement B1.

## Requirements

### Server
- Add `socket.on("agentAudioChunk", ...)` inside the `/space` namespace
  connection handler. Validate `agentId` and chunk size (<128 KB). Emit
  `listenAudio { agentId, mime, chunk }` to every connected socket.
- Add `GET /listen/:agentId` (requireAuth) that opens an `audio/mpeg`
  stream. Subscribe to ElevenLabs chunks for this agent. Close on client
  disconnect.
- In `app.post("/tts/:agentId/stream", ...)`, after writing each chunk
  to the original response, also push it to every active `/listen/:agentId`
  subscriber.

### Agent client (`public/js/provider-openai-realtime.js`)
- Inside `pc.ontrack`, build a `MediaRecorder` over the inbound stream
  (or over an `audioContext.createMediaStreamDestination()` if the track
  is captured for analysis). Mime: `audio/webm;codecs=opus`. Timeslice
  250 ms.
- Each chunk: `agent.socket.emit("agentAudioChunk", { agentId: AGENT_ID, mime, chunk: arrayBuffer })`.
- Stop recording on `markDisconnected`.

### Dashboard (`public/dashboard.html`, `.css`, `.js`)
- Add a "🎧 listen" button next to each agent badge. Per-agent toggle.
- A "listen all" button in the top bar.
- When on for agent N:
  - In ElevenLabs mode (detect by sniffing `/agent-config` for
    `ttsMode === "elevenlabs"` — or just try /listen first and fall back):
    create `<audio src="/listen/N?key=...">` and play.
  - In WebRTC mode: subscribe to `listenAudio` events for this agent.
    Feed chunks into a `MediaSource` SourceBuffer. Use `audio/webm;codecs=opus`.
  - Show "~N ms behind live" using the existing audio-level RTT estimate
    (or measure: server stamps `t = Date.now()` on each chunk, dashboard
    reads `Date.now() - t` minus playback latency).
- Volume slider per agent. Persist in `sessionStorage`.
- Honor browser autoplay rules: the first listen toggle requires a click,
  which is fine since it's user-initiated.

## Files to modify
- `server.js`
- `public/js/provider-openai-realtime.js`
- `public/dashboard.html`
- `public/dashboard.css`
- `public/dashboard.js`

## How to verify
1. Boot server with `ADMIN_API_KEY` set, open `/alice` and `/bob`, both
   connected and conversing.
2. Open `/dashboard` in a different tab. Toggle 🎧 for Bob. Hear Bob.
3. Toggle 🎧 for Alice. Hear both, separately mutable.
4. Toggle listen on, then disconnect Bob's tab. Listen stops cleanly,
   no console errors, no infinite reconnect loop.
5. Switch agent page to `?tts=elevenlabs`. Listen still works (now via
   `/listen/:agentId` server-side fanout).
6. Audit log entry on first toggle: `audit: listen on agent 0 by <op>`.

## Out of scope
- Recording / persistence of listened audio (separate task — see
  `recording-replay.md` if it gets written).
- Mixing the two agents into a single stream.
- A volume normalization or AGC step. Trust the source.

## Gotchas
- `MediaRecorder` chunk events fire at the timeslice rate even when there
  is silence. That's fine — they're tiny. Don't try to gate on the meter.
- `MediaSource` quirks: append must happen on `sourceopen`, not before.
  Buffer 2–3 chunks before starting playback to avoid stutter.
- Socket payload size: 250 ms of opus ≈ 6–8 KB. Safe under the existing
  `maxHttpBufferSize: 5e6`. Don't drop to 50 ms timeslice — overhead wins.
- Firefox lacks `MediaRecorder` opus support in some versions. Detect via
  `MediaRecorder.isTypeSupported` and fall back to `audio/ogg;codecs=opus`
  if needed. Skip listen mode on browsers that support neither.
- Don't broadcast `listenAudio` to sockets that didn't opt in — add an
  `socket.on("listenSubscribe", { agentId })` / `listenUnsubscribe` flow
  and gate emits per-socket. Otherwise bandwidth balloons.
