# OpenAI Realtime API — What We Learned

This is the non-obvious stuff that took hours to figure out.

## GA vs Beta — They are completely different

OpenAI shipped a **GA (General Availability)** version of the Realtime API in May 2025. The old **Beta** version still exists but is deprecated.

**They use different:**
- Session creation endpoints
- SDP exchange endpoints  
- Client secret formats
- Model names

**You cannot mix GA and Beta.** Using a GA client secret with a Beta SDP endpoint gives a 400 error.

## Correct GA flow

### 1. Create session (server-side, uses your real API key)

```
POST https://api.openai.com/v1/realtime/sessions
Authorization: Bearer sk-proj-...
Content-Type: application/json

{
  "model": "gpt-4o-realtime-preview",
  "modalities": ["audio", "text"],
  "voice": "marin",
  "instructions": "..."
}
```

Response: `{ "client_secret": { "value": "ek_...", "expires_at": ... }, ... }`

The `ek_` prefix means it's a GA ephemeral key. Beta keys had a different format.

### 2. WebRTC SDP exchange (browser-side, uses ephemeral key)

```
POST https://api.openai.com/v1/realtime/calls?model=gpt-4o-realtime-preview
Authorization: Bearer ek_...
Content-Type: application/sdp

<SDP offer from pc.createOffer()>
```

**CRITICAL**: 
- Endpoint: `/v1/realtime/calls` — NOT `/v1/realtime`
- Model param: `gpt-4o-realtime-preview` — NOT `gpt-realtime`
- No `openai-beta: realtime=v1` header

Response: SDP answer (plain text, starts with `v=0`)

### 3. What goes wrong if you use wrong endpoints

| Wrong | Error |
|---|---|
| `/v1/realtime` instead of `/v1/realtime/calls` | "API version mismatch. Cannot start a Realtime beta session with a GA client secret" |
| `gpt-realtime` model instead of `gpt-4o-realtime-preview` | Same version mismatch error |
| `openai-beta: realtime=v1` header present | Same version mismatch error |
| Old Beta endpoint + GA key | 400/401 auth error |

All of these result in "Failed to parse SessionDescription. Expect line: v=" in the browser — because the response is a JSON error, not an SDP.

## Data channel events (what the model sends back)

The agent page communicates with OpenAI via a WebRTC data channel named `"oai-events"`.

### Sending to model

```js
// Send text to model as a user message
dc.send(JSON.stringify({
  type: "conversation.item.create",
  item: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "your text here" }]
  }
}))

// Trigger a response
dc.send(JSON.stringify({ type: "response.create" }))

// Cancel in-progress response (for claim-token)
dc.send(JSON.stringify({ type: "response.cancel" }))

// Update session (live prompt/voice change)
dc.send(JSON.stringify({
  type: "session.update",
  session: {
    type: "realtime",
    instructions: "new system prompt",
    audio: { output: { voice: "cedar" } }
  }
}))

// Text-only mode (for ElevenLabs TTS)
dc.send(JSON.stringify({
  type: "session.update",
  session: { modalities: ["text"] }
}))
```

### Receiving from model

```js
// Speech detected (VAD — someone is talking)
{ type: "input_audio_buffer.speech_started" }

// Speech ended
{ type: "input_audio_buffer.speech_stopped" }

// Model started generating
{ type: "response.created" }

// Streaming text (transcript of what model is saying)
{ type: "response.audio_transcript.delta", delta: "..." }
// OR (GA version)
{ type: "response.output_audio_transcript.delta", delta: "..." }

// Text complete
{ type: "response.audio_transcript.done", transcript: "full text" }
// OR (GA version)
{ type: "response.output_audio_transcript.done", transcript: "full text" }

// Human's speech transcribed
{ type: "conversation.item.created", item: { role: "user", content: [...] } }
```

**Note on transcript event names**: OpenAI renamed these in the GA API. Handle both:
```js
if (msg.type === "response.audio_transcript.done" || 
    msg.type === "response.output_audio_transcript.done" ||
    msg.type === "response.output_text.done") {
  const text = msg.transcript || msg.text
}
```

## Models

| Model | Use case |
|---|---|
| `gpt-4o-realtime-preview` | GA Realtime, good balance |
| `gpt-4o-realtime-preview-2025-04-02` | Specific GA snapshot |
| `gpt-realtime` | DEPRECATED — was the beta alias. Do not use. |

## Voices (GA)

| Voice | Character |
|---|---|
| `marin` | Warm, conversational, feminine-leaning |
| `cedar` | Warm, dry, masculine-leaning |
| `verse` | Youthful, lively |
| `sage` | Calm, measured |
| `ballad` | Musical |
| `alloy` | Neutral |

## Costs

The Realtime API is billed per minute of audio:
- ~$0.06/min input audio
- ~$0.12/min output audio  
- For 2 agents running continuously, that's ~$0.36/min = ~$21/hour

Watch your OpenAI usage dashboard. The session endpoint will silently fail when credits run out.

## Server-side session endpoint pattern

The server mints ephemeral keys so the browser never needs the real API key:

```js
// server.js
app.get("/session/:agentId", async (req, res) => {
  const agentId = parseInt(req.params.agentId)
  const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview",
      modalities: ["audio", "text"],
      voice: voices[agentId],
      instructions: prompts[agentId]
    })
  })
  const data = await r.json()
  // Return the client_secret (ephemeral key) to the browser
  res.json({ value: data.client_secret.value, model: data.model })
})
```

The browser then uses `data.value` as the Bearer token for the SDP POST.
