# Voice Task 03 — Per-sentence streaming TTS (lower first-byte latency)

## Context

In ElevenLabs mode the page currently waits for `response.output_text.done`
(or `response.audio_transcript.done`) before sending the *entire* utterance to
`/tts/:id/stream`. For a 4-sentence reply that's an avoidable 1–2 second delay.

OpenAI Realtime emits `response.output_text.delta` (and the audio_transcript
equivalent) every ~50–200 ms. We can batch deltas by sentence boundary, fire a
TTS call as soon as a complete sentence lands, and play sentences back-to-back
in the existing sequential queue.

This is the "Option B" the original spec mentioned. Option A (the current
whole-utterance path) stays as a safety net.

**Run after Voice Task 05 (model update).**

## Requirements

### Behavior

1. When `USE_ELEVEN` is true, accumulate `response.output_text.delta` /
   `response.audio_transcript.delta` events into a buffer.
2. **Flush a sentence** whenever the buffer ends with one of `. ? ! …` AND the
   buffer length is ≥ `MIN_SENTENCE_CHARS` (default 12). This avoids
   single-letter "a." flushes.
3. Also flush on a **softer secondary trigger**: a `,` or `;` at the end of the
   buffer once the buffer is ≥ 60 characters AND ≥ 350 ms have passed since
   the last flush. This keeps long unpunctuated sentences from stalling.
4. On the `*.done` event, flush whatever is in the buffer (even if it doesn't
   end with punctuation).
5. Each flush calls `speakViaElevenLabs(sentence)` which goes through the
   existing `speakChain` promise queue, so playback order is guaranteed.
6. The first flush sets `setStatus("speaking")`. The last `audio.onended`
   sets `setStatus("idle")` and emits `releaseTurn`.
   - To know "the last one", track a counter (`pendingUtterances`) — increment
     on flush, decrement on `audio.onended`. Emit `releaseTurn` when it
     reaches 0 AND `*.done` has fired.

### Why the chosen punctuation regex

Use `/[.?!…](\s|$)/` for hard breaks (the `…` catches `…`). This
avoids splitting decimals like `3.14` because there's no trailing space.

### Tuning knobs

Expose three constants near the top of the EL block:

```js
const MIN_SENTENCE_CHARS = 12
const SOFT_FLUSH_CHARS   = 60
const SOFT_FLUSH_MS      = 350
```

Don't make them env-configurable from the browser — they're code-tunable
defaults. The server already has the cost-side knobs.

### Fallback

If the model produces no delta events for any reason (e.g., the audio_transcript
deltas were never wired up server-side for this session), the existing
`*.done` handler still fires `speakViaElevenLabs(finalText)`. Don't remove
that path. Detect "we already streamed everything" by checking the buffer/
pending state — if you've already flushed every chunk, the done handler
becomes a no-op.

### What stays the same

- The `speakChain` queue: keep it. Sentence flushes append; playback stays
  sequential.
- `setupAudioAnalysis` via `captureStream()`: keep it. The meter should
  pulse on each sentence's playback.
- `/tts/:id/stream` server-side: no changes needed. Each sentence is just a
  shorter POST.

## Files to Modify

- `public/js/provider-openai-realtime.js` — single file, single mode (EL).

## Files NOT to Touch

- `server.js`
- `public/js/agent-common.js`
- `providers/**`
- Existing tests in `tests/client/` (update or extend if Voice Task 01 already
  shipped — add the new sentence-flush tests alongside the existing ones).

## Acceptance Criteria

- [ ] Loading `/server-agent1?tts=elevenlabs` (auth on) and triggering a 3-sentence
      response shows the first audio playing within ~1 second of the LLM
      starting (verify in the activity log + network tab).
- [ ] Sentences play in order with no overlap.
- [ ] `releaseTurn` fires exactly once per response.
- [ ] If you mute the model's text mid-response (set the data channel to drop),
      whatever has been buffered still gets spoken on `*.done`.
- [ ] No regression in default (non-EL) mode — the Realtime audio path is
      untouched.
- [ ] If Voice Task 01 (client tests) has shipped, add 3 new tests:
      sentence-boundary flush, soft-flush on long buffer, single-`releaseTurn`
      across multi-sentence responses.

## Don'ts

- Don't switch to the WebSocket EL endpoint — that's Voice Task 11.
- Don't lower `MIN_SENTENCE_CHARS` below 8 (you'll start splitting "Hi." into
  noise tokens).
- Don't pre-warm `/tts/:id/stream` with empty text to reduce latency — that
  consumes EL credits and trips the rate limit.
- Don't run TTS calls in parallel for the same agent — keep the `speakChain`
  queue. Out-of-order audio is worse than a 100 ms wait.
