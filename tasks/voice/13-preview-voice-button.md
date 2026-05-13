# Voice Task 13 — "Preview voice" button on agent pages

## Context

Operators currently can't audition an ElevenLabs voice without putting the
agent into a live Space and waiting for it to talk. A 1-click preview that
plays a short, known sample via `/tts/:id/stream` would massively speed up
voice tuning.

This is a small UI win — self-contained, no backend changes.

## Requirements

### 1. UI

In `public/server-agent1.html` and `public/server-agent2.html` (and the
dashboard if Voice Task 12 has shipped), add a "Preview" button next to the
voice picker:

```
Voice: [Rachel ▼]  [▶ Preview]   (ElevenLabs streaming)
```

The button is visible whenever the voice row is visible (i.e. only in
`?tts=elevenlabs` mode). Disabled while a preview is playing.

### 2. Behavior

On click:

1. Read the currently selected `voiceId` from the picker.
2. POST to `/tts/${AGENT_ID}/stream` with body:
   ```json
   {
     "text": "Hey, this is how I sound. Quick check before we go live.",
     "voiceId": "<selected-id>"
   }
   ```
   Use the existing `authHeaders()` helper.
3. Stream the response to an `<audio>` element. **Use a separate element
   from the main playback path** — the operator might click Preview while
   the agent is mid-utterance.
4. Set the button to "Stop" while playing; on `onended`, restore to "Preview".
5. Errors (401, 413, 503): show the message inline next to the button for
   3 seconds, then clear.

### 3. Don't drain the rate limit

Wait — the EL endpoint has a per-IP token bucket (Voice Task 02). A preview
costs one token. That's fine in practice; just be aware that mashing the
button 10 times in 5 seconds will trip the rate limit and that's the
intended behavior. The error message handles it.

### 4. Sample text choice

Use a single shared constant `PREVIEW_TEXT` in `provider-openai-realtime.js`
(or wherever the preview helper lands). Keep it short (≤ 80 chars) to
minimize cost per preview. The sample above is fine; tune if you want.

### 5. Counter visibility

Each preview increments the daily char counter (Voice Task 06). That's
intentional and visible — operators see the cost of voice tuning. Don't
add a "preview doesn't count" bypass; it would defeat the cap's purpose.

## Files to Modify

- `public/js/provider-openai-realtime.js` — add a `previewVoice()` function
  scoped inside the EL block; wire it to the button.
- `public/server-agent1.html` and `public/server-agent2.html` — add the
  `<button id="voicePreviewBtn">` next to the picker.
- If Voice Task 12's dashboard panel is in place: also wire the preview
  button there. The function should live in a shared module
  (`public/js/voice-preview.js`) imported by both agent pages and the
  dashboard.

## Files NOT to Touch

- `server.js` — no backend changes needed; the endpoint is already there.
- `agent-common.js`
- `providers/**`

## Acceptance Criteria

- [ ] Loading `/server-agent1?tts=elevenlabs&key=<correct>` shows the
      Preview button next to the voice picker.
- [ ] Clicking Preview plays the sample.
- [ ] Clicking Preview while playing stops playback and restores the button.
- [ ] Changing the dropdown then clicking Preview plays the new voice.
- [ ] Trying Preview when EL key isn't configured shows a clear inline
      error.
- [ ] Tests (if Voice Task 01 has shipped): add a test that mocks `/tts/0/stream`
      and asserts the preview path creates an Audio element with the streamed
      blob.

## Don'ts

- Don't auto-preview on voice-picker change. Operators don't want surprise
  audio.
- Don't pre-cache previews on page load. Just-in-time only.
- Don't share the preview Audio element with the main playback queue —
  preview is operator-driven and must not affect the live agent's voice.
