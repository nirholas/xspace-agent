# Voice Task 11 — Optional: ElevenLabs WebSocket streaming TTS

## Context

The current EL streaming proxy uses HTTP `POST /v1/text-to-speech/{id}/stream`.
Server-side, we fetch + pipe MP3 chunks to the browser. First-byte latency is
~250–500 ms per call.

ElevenLabs also offers a WebSocket endpoint at
`wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input` that
accepts text incrementally and streams back PCM/MP3 chunks as soon as bytes
are ready. First-byte latency drops to ~100–200 ms and you can keep the
socket open across a multi-sentence response — much lower overhead per
sentence than HTTP.

This task adds a parallel mode (`?tts=elevenlabs-ws`) without removing the
HTTP path. The HTTP mode stays as the default and the WS mode is opt-in
until proven stable.

**Run after Voice Tasks 03 and 04** — the sentence-flush queue and barge-in
infrastructure are prerequisites.

## Requirements

### 1. Server-side: WebSocket proxy

Add an endpoint `GET /tts-ws/:agentId` that:

1. Upgrades the HTTP request to a WebSocket. Use the `ws` library
   (`pnpm add ws`).
2. Auth-gates the upgrade. The browser must include the admin key in the
   subprotocol or query string (browsers don't support custom headers on
   WebSocket upgrades). Use `?key=…` as the only mechanism; reject if
   missing or invalid via `socket.close(4001, "unauthorized")`.
3. Opens a corresponding upstream WebSocket to ElevenLabs using
   `ELEVENLABS_API_KEY` as the `xi-api-key` header.
4. Relays messages bidirectionally:
   - Browser → server: text chunks `{ type: "text", text }` and
     `{ type: "flush" }` and `{ type: "end" }`.
   - Server → upstream EL: the EL's expected message shape (see
     [EL WebSocket docs](https://elevenlabs.io/docs/api-reference/websockets)).
   - Upstream EL → server: audio chunks (base64-encoded JSON).
   - Server → browser: audio chunks as binary frames (decoded base64 → raw
     bytes) so the browser can feed them to a `MediaSource` directly.
5. Apply the same guardrails as HTTP:
   - Per-IP rate limit (separate bucket from the HTTP one, but same semantics).
   - Daily char cap (shared with HTTP — both increment the same counter).
   - Voice-ID regex.
6. Close the upstream socket when the browser disconnects.
7. Audit any voice change that happens mid-session via the `setVoice` socket
   (existing handler — no change needed there).

### 2. Browser-side: WS mode in `provider-openai-realtime.js`

Add a third TTS mode alongside `realtime` (default) and `elevenlabs` (HTTP):

```
?tts=elevenlabs-ws  → USE_ELEVEN_WS
```

When `USE_ELEVEN_WS` is true:

1. On data-channel open, request text-only output (same as HTTP EL mode).
2. Open a single WebSocket to `/tts-ws/${AGENT_ID}?key=${encodeURIComponent(AGENT_AUTH_KEY)}`.
3. Use `MediaSource` API to play the streamed bytes:
   - Create a `<audio>` element with `src = URL.createObjectURL(mediaSource)`.
   - On `sourceopen`, add a `SourceBuffer` with the correct MIME type
     (`audio/mpeg` for MP3 output).
   - As binary frames arrive on the WS, push them into the source buffer
     using `appendBuffer`.
   - Manage backpressure: only append when `sourceBuffer.updating === false`;
     queue otherwise.
4. Sentence-flush logic from Voice Task 03 still applies but the flush is
   now `ws.send({ type: "text", text: sentence })` instead of a fresh
   `fetch`.
5. Barge-in (Voice Task 04) sends `ws.send({ type: "flush" })` and resets the
   MediaSource: `sourceBuffer.abort()`, `mediaSource.endOfStream()`, create
   a new one for the next response.
6. Reconnect logic: if the WS drops, fall back gracefully to HTTP mode
   (re-execute the existing HTTP path for any remaining text).

### 3. Server-side state sharing

The daily char cap counter, rate-limit bucket map, and `elevenVoiceIds` all
need to be reachable from both the HTTP route and the WS upgrade handler.
Move them into a single module (`lib/eleven-state.js` or
`packages/server/src/lib/eleven-state.ts` if Voice Task 10 has shipped).

### 4. Acceptance metric

The latency improvement should be measurable. Add a simple log line in the
client on first audio byte received:

```
[EL-WS] first byte: 142 ms
[EL-HTTP] first byte: 384 ms
```

Verify the WS mode delivers a meaningful improvement (≥100 ms reduction in
first-byte) under realistic conditions. If it doesn't, file a follow-up and
keep HTTP as the default — don't ship a more-complex code path for zero
benefit.

## Files to Create

- `lib/eleven-state.js` (or migrate existing state into it).
- `routes/tts-ws.js` (or add the upgrade handler inside `server.js` if you're
  keeping it monolithic) — your call, but extract if the file is getting
  unwieldy.

## Files to Modify

- `server.js` (or `packages/server/src/index.ts` if Task 10 shipped) — wire the
  WS upgrade handler.
- `public/js/provider-openai-realtime.js` — add `USE_ELEVEN_WS` mode.
- `package.json` — add `ws` as a dep with justification.
- `.env.example` — document any new env vars (probably none beyond the
  existing EL ones; just note that the WS mode honors them).

## Files NOT to Touch

- `agent-common.js`
- `providers/**`
- HTTP EL mode behavior (don't degrade Option A while adding Option C).

## Acceptance Criteria

- [ ] `?tts=elevenlabs` (HTTP) still works exactly as before.
- [ ] `?tts=elevenlabs-ws` (WS) plays audio with measurably lower first-byte
      latency.
- [ ] Barge-in still cancels playback within ~200 ms in WS mode.
- [ ] WS auth gate: `?key=<wrong>` is rejected with close code 4001.
- [ ] Daily char cap is enforced consistently across HTTP and WS modes.
- [ ] Network glitch test: kill the WS server-side, verify the client falls
      back to HTTP mode without operator intervention.

## Don'ts

- Don't make WS the default until at least a day of live use shows no
  regressions.
- Don't share a single upstream WS across multiple browser sessions — one
  upstream per agent page.
- Don't proxy binary EL frames through a base64 string just because it's
  easier — use WS binary frames so the browser doesn't pay the decode tax.
- Don't bypass the daily char cap. Two streaming modes ≠ two budgets.
