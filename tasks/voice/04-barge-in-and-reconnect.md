# Voice Task 04 — Barge-in (interruption) + WebRTC reconnect

## Context

Right now if a human starts speaking while the agent is mid-utterance, the
agent keeps talking until its sentence finishes — that's ~3–8 seconds of
"AI doesn't notice you", which makes it feel obviously non-human. We have
the signal already: OpenAI Realtime emits `input_audio_buffer.speech_started`
on the data channel the moment VAD detects voice input.

Also: if the WebRTC connection drops (network blip, server restart, ICE
failure), the page sits in a broken state until the operator hits **Connect**
again. We should auto-reconnect with exponential backoff.

**Run after Voice Task 03 (per-sentence streaming).** The sentence queue
makes barge-in much cleaner because cancelling means dropping the queue and
stopping at most one ~3-second clip, not a 30-second one.

## Requirements

### 1. Barge-in

Target latency from `speech_started` to silenced agent: **≤ 200 ms**.

Implementation:

1. Add a `currentAudioEl` and a `speakChainAbort` (an `AbortController`) at the
   EL section's scope.
2. On `input_audio_buffer.speech_started`:
   - Set a boolean `bargedIn = true`.
   - Call `currentAudioEl.pause()` and set `currentAudioEl.src = ""` (releases
     the buffer instantly).
   - Call `speakChainAbort.abort()` and replace it with a fresh
     `AbortController` for the next response.
   - **Cancel any in-flight `/tts/:id/stream` fetch** via the controller's
     signal — pass `signal: speakChainAbort.signal` to the fetch call.
   - Send `{ type: "response.cancel" }` over the data channel so OpenAI stops
     generating further tokens.
   - Emit `releaseTurn` so the server's turn arbitration unsticks.
   - Reset `pendingUtterances = 0` and clear the sentence buffer.
   - Log: `"Barge-in: cancelled current response"`.
3. On `input_audio_buffer.speech_stopped`: reset `bargedIn = false`. (No action
   needed besides clearing the flag — the next `response.created` cleans up.)
4. New responses that arrive (`response.created`) reset `bargedIn = false`
   defensively and rebuild the abort controller.

### 2. Auto-reconnect

When `pc.iceConnectionState` transitions to `"failed"` or `"disconnected"`:

1. Mark disconnected in the UI immediately.
2. Wait `backoff(attempt)` ms, where `backoff(n) = min(30000, 500 * 2^n)`.
3. Call `startConnection()` again.
4. Cap at 5 attempts. After that, surface a clear error and leave the
   Connect button enabled so the operator can retry manually.
5. Reset the attempt counter on a successful ICE `"connected"`.

`"closed"` is a terminal user-initiated state — don't auto-reconnect from it.

### 3. Hard cleanup on Connect button

The Connect button currently leaks: clicking it twice creates two PeerConnections
and two data channels. Add a guard that calls `cleanup()` first:

```js
function cleanup() {
  try { dc?.close() } catch (_) {}
  try { pc?.close() } catch (_) {}
  pc = null; dc = null
  speakChain = Promise.resolve()
  pendingUtterances = 0
  if (currentAudioEl) { try { currentAudioEl.pause() } catch (_) {} ; currentAudioEl.src = "" ; currentAudioEl = null }
  agent._elevenMeterAttached = false
}
```

Call `cleanup()` at the top of `startConnection` and at the top of the reconnect
retry loop.

### 4. Tracking the current audio element

`playOne(text)` already creates `new Audio(blobUrl)`. Hoist that reference to
`currentAudioEl` so `pause()` can reach it. Set `currentAudioEl = null` at the
end of `playOne` (or in `finally`).

## Server-side changes

None required. `response.cancel` is handled by OpenAI Realtime upstream. The
existing `/tts/:id/stream` proxy already cancels its reader when the response
is closed — when the browser aborts the fetch, the proxy auto-tears down. No
new endpoint needed.

If you find that aborting the fetch leaves the EL upstream connection open
(check by watching `pactl list short sink-inputs` and the EL dashboard during
test), file a follow-up; don't try to fix it here.

## Files to Modify

- `public/js/provider-openai-realtime.js` — main work.
- `public/js/agent-common.js` — only if needed: expose `markDisconnected()` /
  `markConnected()` if not already public (they appear to be — verify).

## Files NOT to Touch

- `server.js`
- `providers/**`
- Anything under `packages/**`

## Acceptance Criteria

- [ ] In a live Space, talking over the agent silences it within ~200 ms.
- [ ] After barge-in, the operator can speak normally and the agent responds
      again on the next utterance (no stuck state).
- [ ] Killing the network for 3 seconds and bringing it back reconnects
      automatically.
- [ ] Repeatedly clicking Connect doesn't stack PeerConnections (verify in
      `chrome://webrtc-internals`).
- [ ] Existing default (non-EL) mode still works: barge-in is a no-op in that
      mode (the model's own VAD already handles it via the audio track).
- [ ] If Voice Task 01 shipped, add tests: barge-in cancels playback, abort
      controller signal propagates to fetch, reconnect retries with backoff.

## Don'ts

- Don't try to "fade out" the audio — abrupt is correct for barge-in. Humans
  do the same thing when interrupted.
- Don't lower the ICE state check to `"checking"` or `"new"` — those are normal
  transitional states; reconnecting from them creates a loop.
- Don't poll for connection health on a timer. Use the existing ICE state
  callbacks.
- Don't reconnect if the user manually disconnected (track an `intentionalClose`
  flag).
