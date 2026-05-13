# Task: Turn Queue + Latency Telemetry

## Context
The server already broadcasts `turnQueue` inside every `stateUpdate`
payload, but the dashboard renders the "current turn" field only and
ignores the queue entirely. The dashboard also has no sense of how slow
or fast a turn is — when an LLM provider degrades, the operator finds
out from listeners complaining, not from the dashboard.

## Goal
Render the live turn queue ("now: Alice → next: Bob → idle") and expose
two latency numbers per turn:
1. **TTFT** — time from `response.create` (or `textDelta` first emit) to
   the first audible audio chunk.
2. **Total turn duration** — `response.create` to `response.done` or
   `textComplete`.

Show p50 / p95 over the last 20 turns per agent, plus a per-turn sparkline.

## Why now
Latency regressions in OpenAI Realtime, ElevenLabs, or Groq are silent
right now. The dashboard is the natural place to surface them.

## Requirements

### Server (`server.js`)
- Maintain a per-agent ring buffer of the last 20 turns:
  ```js
  const turnHistory = { 0: [], 1: [] }  // { startedAt, firstAudioAt, completedAt, textChars, source }
  ```
- Wire timestamps:
  - On `socket.on("textDelta", ...)` first delta of a `messageId`: set
    `startedAt` (the server's first observation).
  - On a new event `agentAudioChunk` (added in `02-listen-mode.md`) or
    on the first `ttsAudio` emit: set `firstAudioAt` if not yet set.
  - On `socket.on("textComplete", ...)`: set `completedAt`, push to ring.
- Emit a `turnComplete` socket event with `{ agentId, durationMs, ttftMs, chars }`
  per finished turn.
- Add `GET /metrics/turns` (gated) that returns:
  ```json
  {
    "0": { "count": 12, "p50DurMs": 2400, "p95DurMs": 4100, "p50TtftMs": 380, "p95TtftMs": 720, "recent": [...] },
    "1": { ... }
  }
  ```

### Dashboard
- Top bar: replace `Floor: <agent>` with a queue rendering. CSS chain:
  `[Alice · speaking] → [Bob · queued]` with the active one pulsing.
  Use the `turnQueue` field on every `stateUpdate` plus `currentTurn`.
- Per-agent card: new "latency" line under the meter showing
  `last: 2.4s · TTFT 380ms · p95 4.1s`. Update on `turnComplete`.
- Mini sparkline (8 bars, last 8 turn durations). Plain DOM (8 divs,
  `height: <pct>%; background: linear-gradient(...)`). No chart library.
- Color-code: green ≤ 3 s total, yellow 3–6 s, red > 6 s. Same for TTFT
  but thresholds 500 ms / 1500 ms.

### Audit
- No audit entries needed for telemetry. Read-only.

## Files to modify
- `server.js`
- `public/dashboard.html` (new latency row + queue markup)
- `public/dashboard.css` (sparkline + queue chip styles)
- `public/dashboard.js` (handle `turnComplete`, render queue,
  compute/display sparklines from `/metrics/turns`)

## How to verify
1. Run the server with both agents connected and an ongoing conversation.
2. Dashboard shows the queue: when Alice finishes and Bob is next, the
   chain shows `[Bob · speaking] → idle`. When both are idle, shows
   `[idle]`.
3. Latency row updates after each turn. Compare against the server log
   (manually wall-clock a turn) — should match within ~50 ms.
4. Provoke a slow turn (temporarily set `OPENAI_REALTIME_MODEL=…` to a
   slow model, or add `await new Promise(r => setTimeout(r, 5000))`
   in the provider response stream). Sparkline bar turns red. Operator
   sees the spike.
5. `curl -H "Authorization: Bearer $KEY" http://127.0.0.1:3000/metrics/turns`
   returns the structured payload.

## Out of scope
- Cost per turn. (Separate Prometheus exporter task, if needed.)
- Long-term storage of latency history. In-memory ring buffer is enough.
- A full chart with axes. Sparklines only.

## Gotchas
- The `messageId` used by `textDelta` and `textComplete` is the agent's
  local ID, set when the data channel emits `response.created`. The
  server already sees it on the first delta — that's a good `startedAt`.
- For the WebRTC path, audio reaches the operator's ear via the agent
  page, not the server, so the server's "first audio" timestamp is from
  the new `agentAudioChunk` socket event (task `02-listen-mode.md`).
  If `02` isn't done yet, approximate TTFT as `startedAt → first textDelta`
  and document the approximation in the dashboard tooltip.
- ElevenLabs path: the first chunk written to `res.write(...)` inside
  `/tts/:agentId/stream` is the server-side audible start. Stamp
  `firstAudioAt` there.
- Don't push the ring buffer over Socket.IO on every change — only
  emit `turnComplete` for the just-finished turn. Dashboards pull
  `/metrics/turns` once on connect and keep their own rolling state.
