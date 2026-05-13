# Task: Rate-Limit Control Events

## Context
ElevenLabs streaming TTS already has a per-IP token bucket on
`/tts/:agentId/stream` (see `.env.example` `ELEVENLABS_BURST` and
matching server.js logic). That protects the spend vector from
ElevenLabs floods.

But the high-cost / high-blast-radius socket events still have no
rate limiter:
- `kickRequest` — every kick triggers an OpenAI Realtime response,
  burning OpenAI quota and broadcasting whatever was generated.
- `promptUpdate` — flipping prompts back-to-back can crash the
  Realtime session and confuses the audience.
- `userMessage` — drives the agent the same as a kick. Trivial to flood.
- `xspace:join` / `xspace:leave` — repeated rapid toggles can leave the
  Puppeteer page in a bad state.

A compromised key (or just a bug in a custom dashboard) would let one
client burn an OpenAI Tier-2 budget in minutes.

## Goal
Add a per-operator token-bucket rate limiter to the `/space` namespace
that gates `kickRequest`, `promptUpdate`, `userMessage`, `xspace:*`.

## Why now
Defense in depth. The auth gate keeps unauthorized clients out; rate
limits keep authorized ones from accidentally (or maliciously) draining
quota. Cost: ~30 lines of code, no UX change for normal usage.

## Requirements

### Token bucket
- Per-operator (keyed by `socket.data.operator.name` after task `01`,
  or by the connection IP if multi-operator isn't shipped yet).
- Refills at `RATE_REFILL_PER_SEC` (default 1) tokens per second.
- Burst capacity `RATE_BURST` (default 8).
- Each gated event costs 1 token; `promptUpdate` and `xspace:start` /
  `xspace:join` cost 3 (more expensive operations).

### Library or hand-rolled
Hand-rolled — keep zero new deps. A `Map<key, { tokens, lastRefill }>`
with lazy refill on each request is plenty for this scale.

### Server changes (`server.js`)
```js
const RATE_BURST = Number(process.env.RATE_BURST || 8)
const RATE_REFILL = Number(process.env.RATE_REFILL_PER_SEC || 1)
const buckets = new Map() // key -> { tokens, lastRefill }

function takeToken(key, cost = 1) {
  const now = Date.now() / 1000
  let b = buckets.get(key)
  if (!b) { b = { tokens: RATE_BURST, lastRefill: now }; buckets.set(key, b) }
  const elapsed = now - b.lastRefill
  b.tokens = Math.min(RATE_BURST, b.tokens + elapsed * RATE_REFILL)
  b.lastRefill = now
  if (b.tokens >= cost) { b.tokens -= cost; return true }
  return false
}

function rateGuard(socket, event, cost = 1) {
  const key = socket.data.operator?.name || socket.handshake.address
  if (takeToken(key, cost)) return true
  auditEntry(`rate-limit ${event} (key=${key})`, socket)
  socket.emit("rateLimited", { event, retryAfterMs: 1000 })
  return false
}
```

Wire into each gated handler:
```js
socket.on("kickRequest", (payload) => {
  if (!rateGuard(socket, "kickRequest", 1)) return
  // ... existing handler
})
socket.on("promptUpdate", (payload) => {
  if (!rateGuard(socket, "promptUpdate", 3)) return
  // ...
})
socket.on("userMessage", (payload) => {
  if (!rateGuard(socket, "userMessage", 1)) return
  // ...
})
socket.on("xspace:start", () => { if (!rateGuard(socket, "xspace:start", 3)) return; ... })
socket.on("xspace:join",  () => { if (!rateGuard(socket, "xspace:join", 3)) return; ... })
```

### Cleanup
- Periodic sweep (every 5 min): drop bucket entries whose
  `tokens >= RATE_BURST` and `lastRefill < now - 600 s` to keep the map
  bounded for long-running servers.

### Dashboard
- Subscribe to the `rateLimited` socket event. On hit, show a small
  toast in the inject row: "Rate-limited (retry in 1s)". Disable the
  kick/inject buttons briefly.
- Don't bury the toast — make it visible so operators learn the limit
  before they trip it under stress.

### Env / config
- `RATE_BURST` (default 8)
- `RATE_REFILL_PER_SEC` (default 1)
- Document in `.env.example` under a new "Rate limits" section.

## Files to modify
- `server.js`
- `public/dashboard.html` (toast container if not already present)
- `public/dashboard.css`
- `public/dashboard.js` (handle `rateLimited` event)
- `.env.example`

## How to verify
1. Configure `RATE_BURST=4 RATE_REFILL_PER_SEC=1`.
2. From the dashboard, click "kick" 6 times in 2 seconds. The first 4
   succeed; #5 and #6 trigger a toast. Audit log shows
   `audit: rate-limit kickRequest (key=…)` rows.
3. Wait 1 s, click once — succeeds.
4. With multi-operator (task `01`): two operators each get their own
   bucket. One being rate-limited doesn't affect the other.
5. `pnpm exec node -e "..."` script that fires 100 `kickRequest`s in a
   loop — at most 4 land before the limiter kicks in.
6. Server uptime > 1 hour: `buckets.size` stays bounded (verify with a
   memory/heap check).

## Out of scope
- Rate-limiting HTTP routes. `requireAuth` + per-IP nginx limits cover
  most of that surface. (Add an `express-rate-limit` middleware later if
  needed — separate task.)
- Adaptive rate limiting (back off automatically when OpenAI returns
  429). That's a provider-layer concern.
- Distributed rate limiting (Redis). Single-VM only.

## Gotchas
- Use `socket.data.operator.name` when task `01` is done, otherwise
  fall back to `socket.handshake.address`. Don't key on `socket.id` —
  it changes on reconnect.
- The `rateLimited` emit goes to the offending socket only, not the
  whole namespace. Other dashboards shouldn't be polluted with toasts
  for someone else's flood.
- Cost of 3 for `promptUpdate` / `xspace:join` is a deliberate
  asymmetry — make the burst capacity feel snappy for kicks (which are
  common) while making prompt-flipping feel deliberate.
- The audit row is rate-limited itself by being a side-effect of a
  rate-limit hit. Don't loop. If the bucket is empty for the *audit*
  emit path, skip — but the audit emit doesn't pass through the bucket,
  it's a direct call to `auditEntry`. Safe.
