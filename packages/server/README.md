# @xspace/server

Admin panel and WebSocket API server for xspace-agent.

## Quick start

```bash
pnpm build   # compile TypeScript → dist/
pnpm start   # node dist/index.js
pnpm dev     # tsc --watch (development)
pnpm test    # vitest run
```

## REST Endpoints

### Unauthenticated

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Load-balancer health check |
| GET | `/metrics` | Prometheus metrics |
| GET | `/metrics/json` | JSON metrics |
| GET | `/` | Hub page (`public/index.html`) |
| GET | `/dashboard` | Dashboard (key injected when provided) |
| GET | `/config` | AI provider and agent status |

### Authenticated (requires `ADMIN_API_KEY`)

Authentication is accepted via any of:
- `Authorization: Bearer <key>` header
- `X-API-Key: <key>` header
- `?key=<key>` query parameter (legacy browser compat)
- `?apiKey=<key>` query parameter

#### Operator HTML pages (auth + key injection)

| Method | Path | Served file |
|--------|------|-------------|
| GET | `/admin` | `public/admin.html` |
| GET | `/builder` | `public/builder.html` |
| GET | `/server-agent1` | `public/agent1.html` |
| GET | `/server-agent2` | `public/agent2.html` |

Each page has `window.AGENT_AUTH_KEY = "<key>"` injected before `</head>` so
the page's JavaScript can authenticate to Socket.IO without prompting the
operator again.  Without a valid key the server returns an inline login form
for browser requests or `401 { error: "unauthorized" }` for XHR/API clients.

#### ElevenLabs TTS streaming proxy

**POST `/tts/:agentId/stream`**

Streams MP3 audio directly from ElevenLabs so the browser page never sees the
API key.  `agentId` must be `0` or `1`.

Request body (JSON):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | yes | Text to synthesise (max `ELEVENLABS_MAX_TEXT_CHARS`) |
| `voiceId` | string | no | Override voice ID (16–40 alphanumeric chars). Defaults to runtime voice for the agent. |

Response: `audio/mpeg` stream, `Cache-Control: no-store`.

Error responses (wire-compatible with legacy `server.js`):

| Status | Body | Condition |
|--------|------|-----------|
| 400 | `{ error: "invalid agent id" }` | agentId not 0 or 1 |
| 400 | `{ error: "missing text" }` | text absent or blank |
| 400 | `{ error: "invalid voice id" }` | voiceId fails regex |
| 413 | `{ error: "text too long (max N chars)", length: N }` | text exceeds cap |
| 429 | `{ error: "rate limit exceeded (TTS)" }` | token bucket exhausted |
| 503 | `{ error: "daily TTS cap reached", capacity: N, used: N }` | daily char limit hit |
| 500 | `{ error: "ELEVENLABS_API_KEY not configured" }` | missing API key |

Rate limiting: token bucket per client IP — 1 token/second refill, burst capacity
set by `ELEVENLABS_BURST` (default 8).  A `costWarning` Socket.IO event is emitted
to the `/space` namespace when usage crosses 80 % and 95 % of the daily cap.

#### ElevenLabs voice catalog

**GET `/voices`**

Returns the ElevenLabs voice catalog (cached 5 minutes) plus the current
runtime voice IDs.

Response shape:

```json
{
  "voices": [
    {
      "id": "...",
      "name": "Rachel",
      "category": "premade",
      "description": "calm",
      "labels": { "description": "calm" },
      "preview": "https://..."
    }
  ],
  "current": { "0": "<agentId0VoiceId>", "1": "<agentId1VoiceId>" }
}
```

#### Admin / selector endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/state` | Current state snapshot (last 50 messages) |
| POST | `/admin/selectors/:name` | Override CSS selector |
| GET | `/admin/selectors/health` | Validate all selectors |
| GET | `/admin/selectors/failures` | Selector failure report |
| GET | `/admin/providers` | Provider status + costs |
| GET | `/admin/providers/costs` | Cost tracking (`?since` filter) |
| GET | `/admin/providers/health` | Provider health checks |

## Socket.IO Namespace: `/space`

Auth: `socket.handshake.auth.apiKey` or `x-api-key` handshake header.

### New event — `setVoice`

**Client → Server**

```json
{ "agentId": 0, "voiceId": "AbCdEfGhIjKlMnOp" }
```

Changes the ElevenLabs voice used by `/tts/:agentId/stream` at runtime without
redeploying.  `agentId` must be 0 or 1; `voiceId` must be 16–40 alphanumeric
characters.  Invalid payloads are silently ignored (same as legacy behaviour).

**Server → Client (on success)**

```json
// voiceUpdated
{ "agentId": 0, "voiceId": "AbCdEfGhIjKlMnOp" }

// auditLog
{ "id": "audit-...", "agentId": -2, "name": "audit", "text": "voice change agent 0: old → new  (from ip)", "timestamp": 1234, "isAudit": true }
```

### Other events

See [CLAUDE.md](./CLAUDE.md) for the full Socket.IO event reference.

## Environment variables

All variables are shared with (and backwards-compatible with) the legacy
`server.js`.  No new names are introduced.

| Variable | Default | Description |
|----------|---------|-------------|
| `ELEVENLABS_API_KEY` | — | ElevenLabs API key (required for TTS/voices) |
| `ELEVENLABS_MODEL` | `eleven_turbo_v2_5` | TTS model ID |
| `ELEVENLABS_OPTIMIZE_LATENCY` | `2` | Streaming latency optimisation level |
| `ELEVENLABS_OUTPUT_FORMAT` | `mp3_22050_32` | Audio output format |
| `ELEVENLABS_VOICE_0` | `S9NKLs1GeSTKzXd9D0Lf` | Default voice for agent 0 |
| `ELEVENLABS_VOICE_1` | `AZnzlk1XvdvUeBnXmlld` | Default voice for agent 1 |
| `ELEVENLABS_MAX_TEXT_CHARS` | `1500` | Max chars per TTS request |
| `ELEVENLABS_BURST` | `8` | Token-bucket burst capacity |
| `ELEVENLABS_DAILY_CHAR_CAP` | `200000` | Daily character limit |
| `ADMIN_API_KEY` | — | API key for all authenticated endpoints |
| `PORT` | `3000` | HTTP listen port |
| `CORS_ORIGINS` | `http://localhost:<PORT>` | Comma-separated allowed CORS origins |

## Migration note

`POST /tts/:id/stream`, `GET /voices`, and `setVoice` replace the equivalent
paths in the root-level `server.js`.  **Both implementations run in parallel
during the transition period** — `npm run start:legacy` keeps using `server.js`
while `npm run dev` (or `pnpm start` from this package) uses this server.
The wire formats are identical so browser pages work against either server
without changes.

Operator pages served from `packages/server/public/` correspond to the legacy
`public/` files as follows:

| Legacy path | New path |
|-------------|----------|
| `/server-agent1` → `public/server-agent1.html` | `/server-agent1` → `public/agent1.html` |
| `/server-agent2` → `public/server-agent2.html` | `/server-agent2` → `public/agent2.html` |
| `/admin` → `public/admin.html` | `/admin` → `public/admin.html` |
| `/builder` → `public/builder.html` | `/builder` → `public/builder.html` |

> ⚠️ Railway production serves from `packages/server/public/`.  HTML changes
> intended for production must be applied there, not in the root `public/`.
