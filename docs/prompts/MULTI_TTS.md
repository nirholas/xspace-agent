# Spec 4 — Multi-provider TTS with live switching

`nirholas/xspace-agent` currently supports two TTS modes via the `?tts=` URL parameter on the agent pages:
- `?tts=realtime` (default) — OpenAI Realtime model outputs audio directly via WebRTC
- `?tts=elevenlabs` — model outputs text, page POSTs to `/tts/:agentId/stream` server-side proxy, server pipes ElevenLabs MP3 stream back

Extend this to a proper multi-provider TTS system. Voice choice should be **live-switchable** during an active Space without disconnecting the OpenAI Realtime session.

## Providers to support

1. `realtime` — OpenAI Realtime audio out (current)
2. `openai-tts` — OpenAI TTS-only via `/v1/audio/speech` (model `gpt-4o-mini-tts` or `tts-1-hd`)
3. `elevenlabs-http` — ElevenLabs streaming via HTTP (current `?tts=elevenlabs`)
4. `elevenlabs-ws` — ElevenLabs streaming via WebSocket (lower latency, supports per-sentence chunking)
5. `cartesia` — Cartesia Sonic streaming (ultra-low latency, good for real-time)

## What's there now

- `public/js/provider-openai-realtime.js` has a binary toggle (`USE_ELEVEN`) based on `AGENT_CONFIG.tts || ?tts=`.
- Server proxy: `app.post("/tts/:agentId/stream", requireAuth, ...)` calls ElevenLabs HTTP streaming.
- Voice IDs hardcoded as env vars: `ELEVENLABS_VOICE_0`, `ELEVENLABS_VOICE_1`.
- No way to change provider/voice once the page is loaded.

## New shape

### `providers/tts/`

Refactor `providers/tts.js` into a directory:

```
providers/tts/
  index.js              factory + provider interface
  realtime.js           OpenAI Realtime (no-op — handled in-WebRTC)
  openai-tts.js         OpenAI TTS HTTP
  elevenlabs-http.js    ElevenLabs HTTP streaming
  elevenlabs-ws.js      ElevenLabs WebSocket streaming
  cartesia.js           Cartesia Sonic
  types.js              shared types
```

Each non-realtime provider exposes:

```js
// providers/tts/elevenlabs-http.js
module.exports = {
  name: "elevenlabs-http",
  async stream(text, opts, response) {
    // opts: { voice, model, format }
    // response: express Response object — pipe audio bytes into it as MP3
    // returns { firstByteMs, totalBytes }
  },
  async listVoices() {
    // returns Array<{ id, name, description }>
  },
}
```

`providers/tts/index.js` exports `getProvider(name)` and `listAllVoices()`.

### Server: `/tts/:agentId/stream`

Currently POSTs to ElevenLabs HTTP. Replace with:

```js
app.post("/tts/:agentId/stream", requireAuth, async (req, res) => {
  const agentId = parseInt(req.params.agentId)
  const text = (req.body?.text || "").trim()
  const providerName = req.body?.provider || agentTtsState[agentId].provider || "elevenlabs-http"
  const voice = req.body?.voice || agentTtsState[agentId].voice || defaultVoiceFor(providerName, agentId)
  if (!text) return res.status(400).json({ error: "missing text" })
  const provider = require("./providers/tts").getProvider(providerName)
  if (!provider) return res.status(400).json({ error: `unknown provider: ${providerName}` })
  res.setHeader("Content-Type", "audio/mpeg")
  res.setHeader("X-TTS-Provider", providerName)
  res.setHeader("X-TTS-Voice", voice)
  try {
    const result = await provider.stream(text, { voice }, res)
    metrics.ttsLatency.observe({ provider: providerName, agent_id: agentId }, result.firstByteMs / 1000)
    metrics.ttsRequests.inc({ provider: providerName, agent_id: agentId, status: "ok" })
  } catch (e) {
    metrics.ttsRequests.inc({ provider: providerName, agent_id: agentId, status: "error" })
    if (!res.headersSent) res.status(500).json({ error: e.message })
  }
})
```

### Live state per agent

In-memory:

```js
const agentTtsState = {
  0: { provider: process.env.AGENT_0_TTS || "realtime", voice: null, model: null },
  1: { provider: process.env.AGENT_1_TTS || "realtime", voice: null, model: null },
}
```

### Switch endpoint

```js
app.post("/tts/:agentId/config", requireAuth, (req, res) => {
  const agentId = parseInt(req.params.agentId)
  const { provider, voice, model } = req.body || {}
  if (provider) agentTtsState[agentId].provider = provider
  if (voice) agentTtsState[agentId].voice = voice
  if (model) agentTtsState[agentId].model = model
  // Push to the agent page via Socket.IO
  const sock = spaceState.agents[agentId]?.socketId
  if (sock) spaceNS.to(sock).emit("ttsConfigChanged", agentTtsState[agentId])
  res.json({ ok: true, current: agentTtsState[agentId] })
})

app.get("/tts/config", requireAuth, (req, res) => res.json(agentTtsState))
```

### Agent page reacts to live change

In `public/js/provider-openai-realtime.js`:

```js
socket.on("ttsConfigChanged", ({ provider, voice }) => {
  CURRENT_TTS_PROVIDER = provider
  CURRENT_TTS_VOICE = voice
  log(`TTS provider switched live to ${provider} / ${voice}`)

  // If the new provider needs text-only output from Realtime, send session.update
  const needsTextOnly = provider !== "realtime"
  dc.send(JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities: needsTextOnly ? ["text"] : ["audio"],
    },
  }))
})
```

When `output_modalities=["text"]`, the page should:
- Stop receiving `response.output_audio_transcript.*` events (replaced by `response.output_text.*`)
- For each `response.output_text.done` (or sentence-boundary `response.output_text.delta` if chunking), POST the text to `/tts/:id/stream` with `{provider, voice, text}` and play the returned audio.

When switching back to `realtime`, send `output_modalities=["audio"]`.

### Voices listing

```js
app.get("/voices", requireAuth, async (req, res) => {
  const { listAllVoices } = require("./providers/tts")
  res.json(await listAllVoices())
  // { realtime: [...openai voice names...], "openai-tts": [...], "elevenlabs-http": [...], cartesia: [...] }
})
```

The dashboard can render a "voice picker" select that filters by current provider.

## Dashboard UI additions

In `public/dashboard.html` (or `server-dashboard.html`), add a per-agent control:

```html
<div class="agent-panel" data-agent="0">
  <h3>Swarm</h3>
  <label>Provider:
    <select class="tts-provider">
      <option value="realtime">OpenAI Realtime (default)</option>
      <option value="openai-tts">OpenAI TTS</option>
      <option value="elevenlabs-http">ElevenLabs (HTTP)</option>
      <option value="elevenlabs-ws">ElevenLabs (WebSocket)</option>
      <option value="cartesia">Cartesia Sonic</option>
    </select>
  </label>
  <label>Voice:
    <select class="tts-voice"></select>
  </label>
  <button class="apply-tts">Apply</button>
</div>
```

```js
applyBtn.addEventListener("click", () => {
  fetch(`/tts/${agentId}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_AUTH_KEY}` },
    body: JSON.stringify({ provider: providerSel.value, voice: voiceSel.value }),
  })
})
```

When provider select changes, repopulate voice select with that provider's voice list.

## Cartesia integration notes

Cartesia Sonic streaming WebSocket:
- Endpoint: `wss://api.cartesia.ai/tts/websocket?api_key=...&cartesia_version=2024-06-10`
- Send: `{"transcript": "text", "voice": {"id": "..."}, "model_id": "sonic-english", "output_format": {"container":"raw","encoding":"pcm_s16le","sample_rate":16000}}`
- Receive: PCM audio frames (binary)

Implementation requires PCM-to-MP3 transcoding for the existing audio pipeline, OR have the agent page play raw PCM via Web Audio API. The simpler option (for now) is server-side transcoding via `ffmpeg`. Document the trade-off.

## Voice catalog seed

`personas/voice-catalog.json` (referenced by `listAllVoices()`):

```json
{
  "realtime": [
    { "id": "marin",  "name": "Marin",  "description": "warm conversational, ~F" },
    { "id": "cedar",  "name": "Cedar",  "description": "warm dry, ~M" },
    { "id": "verse",  "name": "Verse",  "description": "youthful, lively" },
    { "id": "sage",   "name": "Sage",   "description": "calm, measured" },
    { "id": "ballad", "name": "Ballad", "description": "musical" },
    { "id": "alloy",  "name": "Alloy",  "description": "neutral" }
  ],
  "openai-tts": [
    { "id": "verse",  "name": "Verse",   "description": "expressive" },
    { "id": "shimmer","name": "Shimmer", "description": "bright" }
  ],
  "elevenlabs-http": [],   // populated dynamically from /v1/voices
  "elevenlabs-ws":   [],
  "cartesia": [
    { "id": "...", "name": "Sonic Default" }
  ]
}
```

## Test plan

1. With both agents on `realtime`, verify normal behavior.
2. POST `/tts/0/config` with `provider=elevenlabs-http, voice=<some_eleven_id>`. Verify agent1 switches voice mid-conversation without disconnect.
3. POST `/tts/1/config` with `provider=elevenlabs-ws`. Verify lower latency vs HTTP (compare `xspace_tts_first_byte_seconds` histogram).
4. Try `provider=cartesia`. Confirm audio quality + latency.
5. Switch back to `realtime` mid-Space. Confirm output_modalities returns to audio cleanly.
6. Run the dashboard picker. Apply different voices. Confirm Socket.IO event lands and agent voice changes immediately.

## Don'ts

- Don't ship API keys to the browser. All provider calls go through the server.
- Don't break the existing `?tts=elevenlabs` URL param — keep it as a launch-time override that sets the initial state.
- Don't assume all providers can stream. Provide fallback for non-streaming providers (collect full audio, play). Document latency cost.
- Don't introduce a new auth scheme. Reuse `requireAuth`.

## When done

PR `feat(spec-4): multi-provider TTS with live switching`. Include latency comparison numbers (p50, p95) across providers in the PR body, and a short screen capture of the dashboard switching providers mid-conversation.
