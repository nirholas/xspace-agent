# Spec 3 — Observability: structured logging + metrics

`nirholas/xspace-agent` currently logs ad-hoc `console.log`s. There's no way to:
- Trace a single user-question through the system (audio in → STT → LLM → TTS → audio out)
- See per-provider latency distributions
- Monitor cost drift over time
- Detect anomalies (e.g. an agent suddenly takes 5x longer to respond)

Add **structured logging** (pino — already in `package.json`) and **Prometheus metrics** (prom-client — already in `package.json`) across the server and providers.

## What's there now

`package.json` lists `pino` and `prom-client` as deps but neither is imported anywhere.

## Logger setup

Create `logger.js` at repo root:

```js
const pino = require("pino")

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.OPENAI_API_KEY",
  "*.ELEVENLABS_API_KEY",
  "*.X_AUTH_TOKEN",
  "*.X_CT0",
  "*.ADMIN_API_KEY",
  "*.apiKey",
  "*.password",
  "*.value",  // ephemeral key field
]

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: { paths: redactPaths, censor: "[REDACTED]" },
  base: { service: "xspace-agent", host: process.env.HOSTNAME },
  timestamp: pino.stdTimeFunctions.isoTime,
})

module.exports = {
  logger,
  childFor(component) { return logger.child({ component }) },
}
```

Every existing `console.log` / `console.warn` / `console.error` in `server.js` and `providers/*.js` becomes `log.info(...)` / `log.warn(...)` / `log.error(...)` with structured fields. Examples:

```js
// before
console.log("Session error:", error.response?.data || error)

// after
log.error({ err: error.response?.data || error.message, agentId }, "session_create_failed")
```

Each component gets its own child logger:

```js
// in providers/openai-realtime.js
const log = require("../logger").childFor("provider.openai-realtime")
```

## Correlation IDs

Every Socket.IO event and every HTTP request gets a `cid` (correlation ID). Generated server-side per inbound request, propagated through any downstream calls.

```js
// in server.js, before routes
const { randomUUID } = require("crypto")
app.use((req, res, next) => {
  req.cid = req.headers["x-correlation-id"] || randomUUID().slice(0, 8)
  res.setHeader("x-correlation-id", req.cid)
  next()
})

// Use as log binding
app.get("/session/:agentId", requireAuth, async (req, res) => {
  const log = childFor("session").bind({ cid: req.cid, agentId: req.params.agentId })
  log.info("minting_ephemeral_key")
  // ...
})
```

For Socket.IO, attach a cid to each socket on connection:

```js
spaceNS.on("connection", (socket) => {
  socket.data.cid = randomUUID().slice(0, 8)
  socket.data.log = childFor("socket").bind({ cid: socket.data.cid, socketId: socket.id })
  socket.data.log.info("socket_connected")
})
```

Trace a single conversation turn through the system by grepping for that cid in the logs.

## Metrics

Create `metrics.js` at repo root:

```js
const prom = require("prom-client")
const registry = new prom.Registry()
prom.collectDefaultMetrics({ register: registry })   // process / event-loop

const metrics = {
  registry,

  // counters
  httpRequests: new prom.Counter({
    name: "xspace_http_requests_total",
    help: "Total HTTP requests by route/status",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  }),
  ttsRequests: new prom.Counter({
    name: "xspace_tts_requests_total",
    help: "TTS proxy requests",
    labelNames: ["provider", "agent_id", "status"],
    registers: [registry],
  }),
  realtimeSessions: new prom.Counter({
    name: "xspace_realtime_sessions_total",
    help: "Number of OpenAI Realtime ephemeral keys minted",
    labelNames: ["agent_id", "status"],
    registers: [registry],
  }),
  agentResponses: new prom.Counter({
    name: "xspace_agent_responses_total",
    help: "Completed agent responses (textComplete events)",
    labelNames: ["agent_id"],
    registers: [registry],
  }),
  socketEvents: new prom.Counter({
    name: "xspace_socket_events_total",
    help: "Socket.IO events processed",
    labelNames: ["event", "namespace"],
    registers: [registry],
  }),

  // histograms
  httpDuration: new prom.Histogram({
    name: "xspace_http_request_duration_seconds",
    help: "HTTP request latency",
    labelNames: ["method", "route", "status"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  }),
  ttsLatency: new prom.Histogram({
    name: "xspace_tts_first_byte_seconds",
    help: "Time to first byte from TTS provider",
    labelNames: ["provider", "agent_id"],
    buckets: [0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2, 4],
    registers: [registry],
  }),

  // gauges
  agentsConnected: new prom.Gauge({
    name: "xspace_agents_connected",
    help: "Number of agents currently connected to a Realtime session",
    registers: [registry],
  }),
  currentTurn: new prom.Gauge({
    name: "xspace_current_turn",
    help: "agentId who currently holds the floor (-1 if none)",
    registers: [registry],
  }),
}

module.exports = metrics
```

Wire into existing code paths. Examples:

- HTTP middleware: time every request, increment counter on response.
- `/session/:id` handler: increment `realtimeSessions{agent_id, status: "ok"|"error"}`.
- `/tts/:id/stream` handler: time first byte, increment `ttsRequests`.
- `textComplete` socket event handler: increment `agentResponses{agent_id}`.
- `agentConnect` / `agentDisconnect` handlers: bump `agentsConnected`.
- `turnGranted` / `turnReleased` handlers: set `currentTurn`.

## /metrics endpoint

```js
// server.js — gated so randos can't scrape internal metrics
app.get("/metrics", requireAuth, async (req, res) => {
  res.set("Content-Type", metrics.registry.contentType)
  res.end(await metrics.registry.metrics())
})
```

## Cost tracking

Add a small `cost.js` module that estimates dollar cost from token counts and audio durations:

```js
const PRICING = {
  "gpt-realtime": { inputAudioPerMin: 0.06, outputAudioPerMin: 0.24 },
  "gpt-4o-mini-tts": { perChar: 0.000015 },
  "elevenlabs": { perChar: 0.000300 },  // approximate, varies by plan
}

function estimateOpenAIRealtimeCost({ inputAudioSec, outputAudioSec }) {
  const p = PRICING["gpt-realtime"]
  return (inputAudioSec / 60) * p.inputAudioPerMin
       + (outputAudioSec / 60) * p.outputAudioPerMin
}

function estimateTtsCost(provider, chars) {
  const p = PRICING[provider === "elevenlabs" ? "elevenlabs" : "gpt-4o-mini-tts"]
  return chars * p.perChar
}

module.exports = { estimateOpenAIRealtimeCost, estimateTtsCost, PRICING }
```

Expose totals on `/state` (already authed):

```js
app.get("/state", requireAuth, (req, res) => res.json({
  agents: spaceState.agents,
  currentTurn: spaceState.currentTurn,
  messages: spaceState.messages.slice(-50),
  costs: {
    realtimeUsd: spaceState.totalRealtimeCost || 0,
    ttsUsd: spaceState.totalTtsCost || 0,
  }
}))
```

Persist costs to a small JSON file (`/home/agent/x-spaces-v2/costs.json`) and load on startup so a restart doesn't reset history.

## Grafana / Loki / Promtail (optional but documented)

Add `docker/observability/docker-compose.yml` that spins up:
- **Prometheus** scraping `http://host.docker.internal:3000/metrics` every 15 s
- **Grafana** with the bundled dashboard JSON at `docker/observability/grafana/dashboards/xspace.json`
- **Loki** + **Promtail** tailing `/home/agent/*.log` for structured-log search

Dashboard panels:
- Agents connected (gauge)
- Current turn (state timeline)
- HTTP request rate per route
- HTTP p50/p95/p99 latency per route
- TTS first-byte latency by provider
- Realtime sessions minted per minute
- Agent responses per minute by agent
- Estimated cost over time (counter rate × pricing)

## Test plan

1. Send 10 HTTP requests, verify `/metrics` shows `xspace_http_requests_total{...} 10`.
2. Mint 3 ephemeral keys, verify `xspace_realtime_sessions_total{agent_id="0"}` increases.
3. Trigger a fault in `/tts/0/stream` (set wrong key), verify it shows up as `status="error"`.
4. Grep all logs for a single `cid`, see the full trace from HTTP request through Socket.IO event through provider call.
5. Run `docker-compose up` in `docker/observability/`, open Grafana on `localhost:3001`, verify the dashboard loads and panels populate.
6. Confirm logs don't leak the `ADMIN_API_KEY`, X cookies, or OpenAI key (grep the log file for known secret prefixes — should match zero lines).

## Don'ts

- Don't log full `req.body` blindly. Only log known-safe fields.
- Don't add `console.log` regressions. ESLint rule (or `no-console` in production code) is a good idea.
- Don't put the `/metrics` endpoint behind a different auth scheme — reuse `requireAuth`.
- Don't reset metrics on a process restart. prom-client already handles this correctly (counters keep their value across requests, gauges should be re-set on startup).

## When done

PR `feat(spec-3): structured logs + Prometheus metrics`. PR body shows a screenshot of the Grafana dashboard with real traffic and a `grep` excerpt demonstrating correlation-id traceability.
