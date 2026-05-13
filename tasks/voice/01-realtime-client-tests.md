# Voice Task 01 — Vitest suite for `provider-openai-realtime.js` (ElevenLabs mode)

## Context

`public/js/provider-openai-realtime.js` is the browser-side controller for the
two voice agents. It opens an OpenAI Realtime WebRTC session and — when loaded
with `?tts=elevenlabs` or `window.AGENT_CONFIG.tts === "elevenlabs"` — emits
text-only output and synthesizes audio via the server's `/tts/:id/stream` proxy.

It currently has **zero tests**. We shipped the EL streaming path recently; we
need confidence that:

- The mode toggle resolves correctly.
- The sequential MP3 playback queue never overlaps utterances.
- `Authorization: Bearer ${AGENT_AUTH_KEY}` is sent on every protected fetch.
- Status transitions (`speaking` → `idle` + `releaseTurn`) fire on playback end.
- The voice picker populates from `/voices` and emits `setVoice` on change.
- Incoming model audio is ignored when EL mode is on (no doubled voice).
- Realtime audio playback still works in default (non-EL) mode.

## Requirements

### Test runner

- Use **Vitest** with the **jsdom** environment (it's already a workspace dep —
  do not introduce a new one).
- Place tests under a new `tests/client/` directory at the repo root. Wire
  Vitest to pick them up — there's no root `vitest.config.ts` yet, so create
  one at `vitest.config.ts` that only includes `tests/client/**/*.test.{js,ts}`
  for this suite. The existing `packages/core/vitest.config.*` is untouched.

### What the script under test looks like

The script attaches `initOpenAIRealtime` to `window`. To exercise it from a
test, load the file's source via `fs.readFileSync` then `eval` inside the jsdom
window (the standard pattern for testing IIFE-style browser scripts), or
refactor it into an importable ESM module while keeping the existing
`window.initOpenAIRealtime` global as a re-export. **Prefer the ESM refactor**
— make the file ESM-compatible (a single `export function initOpenAIRealtime`
at the bottom plus the existing window assignment). This keeps `<script src>`
working in production and gives the test runner a clean import. Verify nothing
breaks by loading `/server-agent1?tts=elevenlabs` after the change.

### Test cases (minimum)

1. **Mode resolution**
   - Default (no `?tts=` query, no `AGENT_CONFIG.tts`) → realtime mode.
   - `?tts=elevenlabs` → EL mode (USE_ELEVEN truthy).
   - `?tts=eleven`, `?tts=11labs`, `AGENT_CONFIG.tts === "elevenlabs"` → all
     resolve to EL mode.
   - `?tts=` value is case-insensitive (`?tts=ElevenLabs` works).

2. **Auth headers**
   - With `window.AGENT_AUTH_KEY = "test-key"`: fetch calls to `/tts/0/stream`
     and `/voices` carry `Authorization: Bearer test-key`.
   - Without `AGENT_AUTH_KEY`: no `Authorization` header is set.

3. **Sequential playback queue**
   - Fire three transcripts in rapid succession. Assert that the second `fetch`
     to `/tts/0/stream` does not start until the first `Audio.onended` fires.
   - Assert that `releaseTurn` is emitted exactly once per utterance.

4. **Status transitions in EL mode**
   - On `response.output_text.done` (or `response.audio_transcript.done`):
     status becomes `speaking` before playback starts.
   - On `audio.onended`: status becomes `idle`, `socket.emit("releaseTurn", ...)`
     is called with the correct `agentId`.

5. **Model audio ignored in EL mode**
   - When EL mode is on and `pc.ontrack` fires with a stream, `agent.setupAudioAnalysis`
     is **not** called and no `<audio srcObject>` element is appended.
   - When EL mode is off, both still happen (default behavior preserved).

6. **session.update text-only payload**
   - On `dc.onopen` in EL mode, three `session.update` payloads are sent over
     the data channel (`modalities: ["text"]`, `output_modalities: ["text"]`,
     and the nested `audio.output.modalities` form).

7. **Voice picker**
   - When EL mode is on and `#voicePicker` exists, `/voices` is fetched once
     and the dropdown is populated with the returned voices.
   - The voice marked as `current[AGENT_ID]` is pre-selected.
   - On change, `socket.emit("setVoice", { agentId, voiceId })` is called.

8. **Voice updates**
   - When the server emits `voiceUpdated` for this agent, `lastVoiceId` updates
     and the picker `value` syncs.

9. **Delta events**
   - Both `response.audio_transcript.delta` and `response.output_text.delta`
     fire `socket.emit("textDelta", …)`.

10. **Error paths**
    - `/tts/:id/stream` returning 401 logs an error and still emits `releaseTurn`
      (don't leave the agent stuck in `speaking`).
    - `/tts/:id/stream` returning 429 surfaces the message in the log.
    - `audio.onerror` releases the turn the same way `audio.onended` does.

### Mock helpers to write

Create `tests/client/helpers/mocks.js` exporting:

- `createMockSocket()` — `{ on, off, emit, _emit, _handlers }` where `_emit(event, data)`
  triggers handlers registered via `on`.
- `createMockAgent(overrides)` — returns the shape `initOpenAIRealtime` expects:
  `{ AGENT_ID, AGENT_NAME, AUTH_KEY, socket, log, setStatus, setupAudioAnalysis,
  markConnected, markDisconnected, addChat, connectBtn, isSpeaking,
  currentMessageId }`.
- `mockFetch(routes)` — installs a `global.fetch` that matches URL+method
  against a routes table and returns `{ ok, status, json, text, blob, body }`.
- `mockAudio()` — replaces `window.Audio` with a stub whose `.play()` returns a
  promise and exposes `.endNow()` / `.errorNow()` helpers to fire `onended`/`onerror`
  synchronously.
- `mockRTC()` — minimal `RTCPeerConnection`, `createDataChannel` stub that
  records sent payloads and exposes `_fireOpen()` to simulate readiness.

## Files to Create

- `vitest.config.ts` (root) — minimal config, jsdom env, includes `tests/client/**`.
- `tests/client/helpers/mocks.js`
- `tests/client/provider-openai-realtime.test.js`

## Files to Modify

- `public/js/provider-openai-realtime.js` — add a single ESM `export` at the
  bottom alongside `window.initOpenAIRealtime = …`. No behavior changes.
- `package.json` — add a script if not present: `"test:client": "vitest run -c vitest.config.ts"`.

## Files NOT to Touch

- `packages/core/**`, `packages/server/**` — these have their own test setup.
- `server.js`
- `providers/**`

## Acceptance Criteria

- [ ] `pnpm test:client` runs and all tests pass.
- [ ] Loading `/server-agent1?tts=elevenlabs` (with valid `ADMIN_API_KEY`) still
      works after the ESM refactor — verify in a headed browser or via the
      activity log.
- [ ] No real network calls: tests pass with the network disconnected.
- [ ] Tests complete in under 5 seconds.
- [ ] No `console.log` left in the test files.

## Don'ts

- Don't add Playwright. Headless E2E is a separate task (`tasks/16-…`).
- Don't refactor `provider-openai-realtime.js` beyond the single ESM export.
- Don't change `agent-common.js` to "make it more testable" — leave the existing
  agent constructor alone; mock its output shape instead.
