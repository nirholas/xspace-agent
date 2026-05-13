# Voice Task 10 — Port `/tts/:id/stream` and `/voices` to `packages/server`

## Context

`server.js` at the repo root carries a big deprecation warning pointing at
`packages/server/src/index.ts`. The new EL streaming proxy + voice picker
socket handler live in `server.js`. To keep the migration path clean, port
those endpoints to `packages/server/` as TypeScript with Zod validation,
without removing them from `server.js` (legacy still has real users).

## Requirements

### 1. Inventory what to port

From `server.js`:

- `POST /tts/:agentId/stream` — auth, length cap, voice-ID regex, token-bucket
  rate limit, EL streaming proxy.
- `GET /voices` — auth, 5-min cache.
- Socket event `setVoice` on the `/space` namespace — voice-ID validation,
  audit entry, broadcast `voiceUpdated`.
- The static-file gate that wraps operator HTML with auth + auth-key
  injection.

### 2. Implementation rules

- **TypeScript**, with strict mode (the package already uses strict TS).
- **Zod schemas** for request bodies and socket payloads. Use the validation
  patterns already established in `packages/server/src/` (mimic existing
  endpoints).
- Reuse existing auth middleware. If `packages/server` doesn't yet have an
  equivalent of `requireAuth`, port that minimal helper too (same semantics:
  Bearer, X-API-Key, `?key=` fallback, timing-safe compare). Don't import
  Zod twice.
- Express routers should live under `packages/server/src/routes/`. Suggested:
  - `packages/server/src/routes/tts.ts` — TTS stream + voices.
  - `packages/server/src/routes/static-gate.ts` — operator HTML gate.
  - `packages/server/src/socket/voice.ts` — `setVoice` handler.
- Streaming proxy: use `globalThis.fetch` (Node 18+) and pipe the response
  body. Mirror the cancellation semantics from the legacy implementation
  (cancel the upstream reader if the client closes).

### 3. State

Per-IP token bucket, daily counter (if Voice Task 06 has shipped),
`voicesCache`, and `elevenVoiceIds` should all live in a single module
`packages/server/src/lib/eleven-state.ts` so they're testable in isolation
and not sprinkled across route handlers.

### 4. Configuration

Bind to the same env vars as the legacy server. Don't introduce new names.
`OAS_*`-style prefixes are fine internally but the operator-facing env stays
backwards-compatible:

- `ELEVENLABS_API_KEY`
- `ELEVENLABS_MODEL`
- `ELEVENLABS_OPTIMIZE_LATENCY`
- `ELEVENLABS_OUTPUT_FORMAT`
- `ELEVENLABS_VOICE_0` / `ELEVENLABS_VOICE_1`
- `ELEVENLABS_MAX_TEXT_CHARS`
- `ELEVENLABS_BURST`
- `ELEVENLABS_DAILY_CHAR_CAP` (if Task 06 shipped)

### 5. Tests

Mirror Voice Task 02's coverage but inside `packages/server/src/__tests__/`
(or `packages/server/tests/` — match the package's existing convention).

If Voice Task 02 hasn't shipped, write fresh tests for the ported routes.
Tests must NOT depend on the root-level test setup.

### 6. Don't remove from legacy `server.js`

Leave the legacy implementations in place. Users on `npm run start:legacy`
keep working. Migration is informed by Voice Task 12's dashboard panel
showing "served by: legacy" vs. "served by: packages/server" — out of scope
here, but don't preemptively rip out the legacy paths.

### 7. Documentation

Update `packages/server/README.md` (or create one) with:

- New endpoints (`POST /tts/:id/stream`, `GET /voices`, `setVoice` socket event).
- Auth + rate-limit + cap semantics.
- Migration note: "Replaces `server.js` /tts and /voices; both paths run in
  parallel during transition."

## Files to Create

- `packages/server/src/routes/tts.ts`
- `packages/server/src/routes/static-gate.ts`
- `packages/server/src/socket/voice.ts`
- `packages/server/src/lib/eleven-state.ts`
- `packages/server/src/__tests__/tts.test.ts` (or matching package convention)
- `packages/server/src/__tests__/static-gate.test.ts`
- `packages/server/src/__tests__/set-voice.test.ts`
- `packages/server/README.md` updates.

## Files to Modify

- `packages/server/src/index.ts` (or whatever the server entry is) — register
  the new routes + socket handler.
- `packages/server/package.json` — verify deps (`zod`, `express`, `socket.io`
  already present).

## Files NOT to Touch

- `server.js`
- `public/**` (the browser still hits the same URLs; no client change needed)
- `providers/**`
- The legacy `x-spaces/` integration

## Acceptance Criteria

- [ ] `pnpm -F @xspace/server build` and `pnpm -F @xspace/server test` pass.
- [ ] Starting the package server (`pnpm dev` from repo root) and loading
      `/server-agent1?tts=elevenlabs&key=<correct>` works exactly as it does
      against legacy `server.js`.
- [ ] Running both servers on different ports gives byte-identical TTS output
      for the same input text.
- [ ] All Zod validations behave the same as the legacy regex/length checks.
- [ ] `packages/server` still does not require any environment variable that
      legacy didn't.

## Don'ts

- Don't change the wire format of any endpoint. Field names, status codes,
  error JSON shape all stay identical.
- Don't introduce a database or external cache.
- Don't add a `/v2/tts` versioned path. Same path, new implementation.
- Don't migrate the `/session/:id` endpoint in this task — it has provider-
  specific logic that lives in `providers/openai-realtime.js`, and migrating
  that touches Voice Task 05's territory.
