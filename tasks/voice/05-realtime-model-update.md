# Voice Task 05 — Upgrade to current OpenAI Realtime model

## Context

The browser-side client and the server-side session minter both pin
`gpt-4o-realtime-preview-2024-12-17`, which OpenAI is sunsetting in favor of
the GA `gpt-realtime` model (or its current latest dated preview). Newer
revisions also use slightly different event names (e.g. `response.output_text.*`
in addition to / replacing `response.audio_transcript.*`). The code already
handles both event-name families defensively, but the model ID needs updating
and the choice should be env-configurable.

This task is small but unblocks everything else. **Run before Voice Tasks 03,
04, 11** so they iterate on the correct event shapes.

## Requirements

### 1. Make the model env-configurable

There's already an `OPENAI_REALTIME_MODEL` env var documented in `.env.example`
but neither the browser client nor the server session minter uses it. Wire it
in.

### 2. Update the default model ID

Replace the hardcoded `gpt-4o-realtime-preview-2024-12-17` with the **current
recommended Realtime model**. Verify the right model name by checking
[OpenAI's Realtime API docs](https://platform.openai.com/docs/guides/realtime)
before committing — do not guess.

As of writing, candidates in descending preference:
1. `gpt-realtime` (GA, if available in your account).
2. The latest `gpt-4o-realtime-preview-YYYY-MM-DD` dated preview.

If you can't easily verify GA availability, use the newest dated preview that
your `OPENAI_API_KEY` can call — make a small `curl` or `node -e fetch(...)`
probe against `https://api.openai.com/v1/realtime/sessions` and check the
response. Document what you chose and why in the commit message.

### 3. Server-side: `providers/openai-realtime.js`

This file calls `https://api.openai.com/v1/realtime/sessions` with a model
parameter (or builds a session config). Update:

- The model used at session-mint time.
- Any other places the model ID appears.
- Honor `process.env.OPENAI_REALTIME_MODEL` first, falling back to the new
  default.

### 4. Browser-side: `public/js/provider-openai-realtime.js`

The page POSTs the SDP offer to:
```
https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17
```

This is brittle: the model is hardcoded in the URL. Instead:

1. Have `/session/:agentId` (in `server.js` / `providers/openai-realtime.js`)
   return the model name alongside the ephemeral key.
2. Read it from the JSON response and substitute into the SDP URL.

Update the `/session/:agentId` response shape to include `model`:

```js
res.json({
  client_secret: { value: ephemeralKey },
  model: REALTIME_MODEL,            // <-- new
  // ...existing fields
})
```

### 5. Event-name handling

The current code already listens for both `response.audio_transcript.*` and
`response.output_text.*`. Keep both. The new model may emit only one set —
that's fine, the existing OR-handling stays.

But: if the new model also changes `input_audio_buffer.speech_started` to
something else, update the barge-in listener. Verify by enabling verbose
logging during a live test and observing the actual event names.

### 6. Health check on startup

Add a one-time call on server boot that verifies the chosen model is
callable (a no-op session creation with `expires_at` set to now + 10s).
Log:

```
[Realtime] model = gpt-realtime  ✓
```

If the call returns 404/400, log a clear error pointing at the env var and
do NOT crash the server — agents using socket providers still work.

## Files to Modify

- `providers/openai-realtime.js` — model constant + env wiring.
- `public/js/provider-openai-realtime.js` — read model from session JSON,
  substitute into SDP URL.
- `server.js` — only if `/session/:agentId` needs to pass through the new
  field (it should already, since it returns the provider's response verbatim).
- `.env.example` — uncomment `OPENAI_REALTIME_MODEL` and set its default
  to the chosen model with a comment explaining.

## Files NOT to Touch

- All EL TTS code (`/tts/`, `/voices`, etc.)
- `agent-common.js`
- Anything under `packages/**`

## Acceptance Criteria

- [ ] `pnpm run dev` starts cleanly with the new default model.
- [ ] Loading `/server-agent1` and clicking Connect produces a working
      conversation — voice in, voice out (or voice in + EL out when
      `?tts=elevenlabs`).
- [ ] Setting `OPENAI_REALTIME_MODEL=<other>` in `.env` and restarting
      switches the model used by both client and server (verify by inspecting
      the SDP URL in the browser's network panel).
- [ ] The health-check log line appears on every successful boot.
- [ ] Both event families (`response.audio_transcript.*` and
      `response.output_text.*`) still parse correctly — no console errors.

## Don'ts

- Don't remove the old fallback event names. Backwards compat is cheap; we may
  need to roll back.
- Don't hardcode the new model ID anywhere except as the default fallback in
  `providers/openai-realtime.js`.
- Don't ship without verifying the new model name is real. Guessing a model
  name that doesn't exist will break the agent silently — `/session/0` will
  return a 400 only at click time.
