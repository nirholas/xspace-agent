# Voice Task 06 — Daily cost guardrails + `/metrics` endpoint

## Context

The EL streaming proxy is gated by auth and per-call length cap + per-IP
token bucket. What's missing is a **daily ceiling**: a long-running Space
with active agents will burn through ElevenLabs char credits over hours
even with sane per-call limits. We need a hard daily cap, a `costWarning`
event when we're close, and a `/metrics` endpoint so the dashboard can
display it.

This is **additive** to `server.js`. Do not refactor the existing EL block.

**Run before Voice Task 07 (server hardening) to minimize merge conflicts.**

## Requirements

### 1. Daily char cap

Track total ElevenLabs characters sent in a rolling 24-hour window (or
UTC-day window — your call; UTC-day is simpler, just reset at 00:00 UTC).

- Env var: `ELEVENLABS_DAILY_CHAR_CAP` (default `200000` — enough for several
  hours of continuous chatter, but you'll hit it before $10).
- Counter is in-memory only. (Persistence is a separate concern; for our
  scale this is fine.)
- Reset at UTC midnight via a one-shot `setTimeout` that re-arms itself.

Enforcement in `/tts/:agentId/stream`:

1. If `charsSentToday + text.length > CAP` → return `429` with body
   `{ error: "daily TTS cap reached", capacity: CAP, used: charsSentToday }`.
2. On success (response stream completes), increment `charsSentToday` by
   `text.length`. (We count input chars, not output bytes — that's what EL
   bills.)
3. When `charsSentToday / CAP > 0.80` and we cross that threshold for the
   first time today, emit `costWarning` over the `/space` namespace:
   `{ kind: "elevenlabs-daily-80pct", used, cap, percent }`.
4. Same at 0.95.

### 2. `/metrics` endpoint

Add `app.get("/metrics", requireAuth, …)` returning JSON (NOT Prometheus
format — keep it simple, JSON is what our dashboard will eat):

```json
{
  "uptime_seconds": 12345,
  "elevenlabs": {
    "chars_today": 18432,
    "chars_cap_today": 200000,
    "calls_today": 42,
    "rate_limited_today": 3,
    "upstream_errors_today": 0,
    "voices": { "0": "S9NK…", "1": "AZnz…" }
  },
  "openai_realtime": {
    "sessions_minted_today": 8,
    "last_session_at": 1234567890
  },
  "audit_log_size": 14
}
```

All `*_today` fields reset at the same UTC midnight as the EL cap.

To track `sessions_minted_today`, increment a counter inside
`app.get("/session/:agentId", …)` on each successful provider.createSession.

To track `rate_limited_today` and `upstream_errors_today`, increment in the
EL endpoint on the 429 and on the upstream-non-OK branches.

### 3. Audit log size

Already tracked: `spaceState.messages` is capped to 200. Expose its length
under `audit_log_size`.

### 4. Don't break the rate limit

The existing per-IP token bucket already returns 429 on burst. The new daily
cap also returns 429 but with a different body. Either:

- Use 429 for both (operator can distinguish via the JSON `error` field), OR
- Use 503 for the daily cap (resource unavailable until midnight UTC) and
  keep 429 for burst.

**Use 503 for the daily cap.** It signals "different problem, don't just
retry in 1 second".

### 5. `costWarning` socket event

The `/space` namespace already broadcasts to all sockets. Add the event
emission in the EL endpoint code path right after the increment. The
client can `socket.on("costWarning", …)` and surface a banner — out of
scope here (Voice Task 12 wires the panel).

## Files to Modify

- `server.js` — additive only. Put the cost-counter state and the
  `/metrics` endpoint near the existing `/tts/:id/stream` block. Don't reorder
  existing code.
- `.env.example` — document `ELEVENLABS_DAILY_CHAR_CAP` next to the existing
  EL block.

## Files NOT to Touch

- `public/**`
- `providers/**`
- `packages/**`
- The existing per-IP rate-limit bucket — don't touch it; daily cap is a
  separate guard.

## Acceptance Criteria

- [ ] Set `ELEVENLABS_DAILY_CHAR_CAP=200` (a tiny test cap) and a tiny `text`;
      fire 10 requests; observe the cap kick in at the right moment with 503.
- [ ] `costWarning` event fires exactly twice per day (80% and 95% thresholds).
- [ ] `GET /metrics?key=<correct>` returns the expected JSON shape.
- [ ] Without auth: `GET /metrics` returns 401.
- [ ] After UTC midnight the counters reset (verify by overriding `Date.now`
      in a quick test, or just trust the `setTimeout` math).
- [ ] No regressions in existing EL flow: a normal request still streams MP3.

## Don'ts

- Don't add a database. In-memory counters are fine for this scale; if you
  need persistence later, file a follow-up.
- Don't add Prometheus client deps. JSON metrics are sufficient.
- Don't merge this with Voice Task 07. They both touch `server.js` and
  separate PRs are easier to review.
- Don't put the counter reset on a 24-hour `setInterval` from boot time —
  that drifts across restarts. Use a UTC-day-aware re-arm.
