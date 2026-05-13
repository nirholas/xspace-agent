# Voice Task 02 — Vitest + supertest suite for the TTS server endpoints

## Context

`server.js` recently grew an ElevenLabs streaming proxy at `/tts/:id/stream`,
a cached `/voices` endpoint, a `setVoice` socket handler, and a static-file
gate that forces all operator HTML through `requireAuth`. There is currently
**no test** for any of it. Cost-sensitive code paths (rate limit, char cap,
voice-ID validator, auth gate) need automated verification before we run live.

## Requirements

### Test runner

- **Vitest** + **supertest**. Both should be added as `devDependencies` at the
  repo root if not present. Use **pnpm** (`pnpm add -D vitest supertest @types/supertest`).
  No new runtime deps.
- Place tests under `tests/server/`. Reuse the root `vitest.config.ts` from
  Voice Task 01 if it exists (extend its `include` to also pick up
  `tests/server/**`); otherwise create one with `environment: "node"` for this
  suite and `environment: "jsdom"` for the client suite (use Vitest's
  per-file environment comment or two configs run from separate scripts).

### What needs to be testable

`server.js` is a single 1000+ line file that does `app.listen()` at the bottom.
To exercise it with supertest:

1. **Refactor `server.js` to export `{ app, server, io, spaceState }`** without
   changing runtime behavior. Wrap the `server.listen()` call in
   `if (require.main === module) { server.listen(...) }`. This is the only
   structural change you should make to `server.js`.
2. Tests `require("../../server.js")` after setting env vars (`ADMIN_API_KEY`,
   `ELEVENLABS_API_KEY=test`, etc.) and use supertest on the exported `app`.
3. **Mock `global.fetch`** before requiring `server.js` (or at the top of each
   `describe`) so no real ElevenLabs calls leak from tests.

### Test cases (minimum)

1. **Static-file gate**
   - `GET /server-agent1.html` without a key → 401 (HTML login page).
   - `GET /server-agent1.html?key=<bad>` → 401.
   - `GET /server-agent1.html?key=<correct>` → 200, body contains
     `window.AGENT_AUTH_KEY` injection.
   - Same checks for `/bob.html`, `/alice.html`, `/admin.html`, `/builder.html`.
   - `GET /js/agent-common.js` is **not** gated (200 without a key) — static
     assets stay public.

2. **Operator routes**
   - `GET /server-agent1` (no `.html`) without key → 401.
   - `GET /server-agent1?key=<correct>` → 200, body contains `server-agent1.html`
     content and the auth-key injection.

3. **`/tts/:id/stream` — auth**
   - `POST /tts/0/stream` without auth → 401.
   - With auth, missing body → 400 `missing text`.
   - With auth, invalid `agentId` (e.g. `/tts/2/stream`) → 400.

4. **`/tts/:id/stream` — limits**
   - Text exceeding `ELEVENLABS_MAX_TEXT_CHARS` → 413 with `{ length }` in body.
   - `voiceId` failing `VOICE_ID_RE` (e.g. `"../etc/passwd"`, `"short"`) → 400.

5. **`/tts/:id/stream` — rate limit**
   - Set `ELEVENLABS_BURST=3` in the test env. Fire 4 requests from the same IP
     in <1 second. First 3 → 200 (upstream mocked OK), 4th → 429.
   - After waiting 1.5 seconds (or by stubbing `Date.now` to advance), a new
     request succeeds (token refilled).

6. **`/tts/:id/stream` — streaming**
   - Mock `fetch` to return a `ReadableStream` of 3 chunks. Assert the response
     body contains all 3 chunks concatenated, `Content-Type: audio/mpeg`,
     `Cache-Control: no-store`.
   - On upstream non-OK (mock returns 502): response is 502 with upstream
     body forwarded.

7. **`/voices` — cache**
   - First call hits upstream `fetch` once.
   - Second call within 5 minutes does **not** call upstream again.
   - But `current[]` reflects any `setVoice` mutations made between calls
     (test: change voice via socket, then GET /voices, observe new `current[0]`).

8. **`setVoice` socket**
   - Connect a Socket.IO client with a valid `auth.key`. Emit `setVoice`
     with valid `{ agentId: 0, voiceId: <valid-id> }`. Server emits
     `voiceUpdated` with the new id to all sockets.
   - Invalid voiceId → no `voiceUpdated` emitted, voice unchanged.
   - Invalid agentId (e.g. 2) → no change.
   - Connecting without `auth.key` → connection rejected (verify with
     `connect_error` event).
   - After a successful change, `spaceState.messages` contains an `auditEntry`
     mentioning the previous and new voice.

9. **Static-asset cache headers**
   - `GET /js/agent-common.js` does NOT have `Cache-Control: no-store`.
   - `GET /server-agent1.html?key=<correct>` HAS `Cache-Control: no-store`.

### Mock fetch helper

Create `tests/server/helpers/mock-fetch.js` exporting:

- `installMockFetch(routes)` — sets `global.fetch` to a stub matching
  `[method, urlMatcher] → response`. Each response can be `{ ok, status,
  json, text, body: ReadableStream | Buffer | string }`.
- `restoreFetch()` — restores the original.
- `streamFromChunks(chunks)` — builds a web `ReadableStream` from a list of
  Buffers/strings, for testing the streaming proxy.

### Socket client helper

Create `tests/server/helpers/socket-client.js`:

- `connectAsOperator({ key, port })` — returns a connected `socket.io-client`
  socket on the `/space` namespace with `auth: { key }`.
- `waitForEvent(socket, event, timeoutMs=2000)` — promise that resolves on
  first matching event or rejects on timeout.

## Files to Create

- `tests/server/tts-stream.test.js`
- `tests/server/voices.test.js`
- `tests/server/set-voice-socket.test.js`
- `tests/server/static-gate.test.js`
- `tests/server/helpers/mock-fetch.js`
- `tests/server/helpers/socket-client.js`

## Files to Modify

- `server.js` — **only**:
  - Add `module.exports = { app, server, io, spaceState }` at the bottom.
  - Wrap the `server.listen(...)` call in `if (require.main === module)`.
  - Nothing else.
- `package.json` — add `"test:server": "vitest run tests/server"` and
  `"test:voice": "pnpm test:server && pnpm test:client"`.

## Files NOT to Touch

- `public/**`
- `providers/**`
- `packages/**`
- Anything inside `tasks/voice/`

## Acceptance Criteria

- [ ] `pnpm test:server` runs and all tests pass.
- [ ] Tests pass with the network disconnected — no real ElevenLabs calls.
- [ ] `pnpm run dev` still starts the server normally (the `require.main === module`
      guard works).
- [ ] Coverage of `server.js` for the new EL endpoints is ≥90% of lines.
- [ ] No mutation of process-wide state between tests (each `describe` resets
      env, rate-limit buckets, and the voice cache).

## Don'ts

- Don't introduce a real Redis or external service to satisfy state isolation —
  reset in-memory state via exported helpers.
- Don't add an HTTP framework migration. The server is Express; tests run
  against Express.
- Don't refactor the EL endpoint logic — only export and add the listen guard.
- Don't bypass auth in tests by setting `ADMIN_API_KEY=""` — keep auth on and
  pass the key. We want to validate the gate, not skip it.
