# Voice Broadcaster — Follow-on Tasks

These tasks finish the **VM-based two-agent X Spaces voice broadcaster** that
lives at the repo root (`server.js` + `public/alice.html` + `public/bob.html` +
the new `/dashboard` and `/agent-config`/`/health`/`/x-tab-url`/`/kick` API).

They are independent of the SDK tasks in `tasks/01-*` through `tasks/30-*`
(those are about `packages/core`, `packages/server`, and the public landing
site). Don't conflate the two: this track touches `server.js`, `public/*.html`,
`public/js/*.js`, `public/dashboard.*`, and the GCP VM that runs `swarm-server.service`.

Each file in this directory is a self-contained brief for a fresh AI coding
agent. Run them roughly top-to-bottom — the priority is operational safety
and operator UX, then deploy hardening, then personality hot-swap and infra.

## Recommended order

| # | File | Why |
|---|------|-----|
| 01 | `01-multi-operator-auth.md` | Identity in the audit log, revoke without rotating the shared secret |
| 02 | `02-listen-mode.md` | Operator hears what the Space hears — biggest UX win for one chat |
| 03 | `03-turn-queue-and-latency.md` | Render `turnQueue`; surface TTFT + total-turn timings |
| 04 | `04-silence-and-route-health.md` | Parse `pactl` into a route table; alarm when meters silent during `speaking` |
| 05 | `05-transcript-filter-export.md` | Search, filter chips, JSON/text export for postmortems |
| 06 | `06-personality-hot-swap.md` | Move agent prompts out of `server.js` into a config file, hot-reload |
| 07 | `07-consolidate-patch-scripts.md` | Fold the dozen untracked `patch-*.py` / `*-loop.js` scripts into real source |
| 08 | `08-cloudflare-tunnel-and-vercel-split.md` | Production TLS via Tunnel; optional static dashboard on Vercel |
| 09 | `09-preflight-diagnostics.md` | `node scripts/preflight.js` catches missing env/ffmpeg/pactl/cookies before a live show |
| 10 | `10-rate-limit-control-events.md` | Token-bucket on `kick`/`promptUpdate`/`userMessage`; complements existing `/tts` rate-limit |
| 11 | `11-realtime-reconnect.md` | Auto-reconnect WebRTC + Realtime session when ICE/DC drops |
| 12 | `12-vm-runbook.md` | Single doc: deploy, restart, debug. What to do when X tab dies / WebRTC drops / 401s appear |

## Shared context every task assumes

Read these once before any task:

- **Codebase orientation**: `CLAUDE.md` at repo root. Note that `server.js` is
  the legacy entry point that's still authoritative for the voice broadcaster.
  `packages/server` is the future but **does not yet replicate** what
  `server.js` does for X Spaces. Don't move code into `packages/server` as
  part of these tasks — that's a separate migration.
- **Auth model**: `ADMIN_API_KEY` env var gates all privileged routes and the
  Socket.IO `/space` namespace. See `server.js` lines ~64–172 for the
  `requireAuth`, `extractKey`, `timingSafeEqual`, `auditEntry`, and
  `sendWithAuthInjection` helpers. The dashboard logs in via a modal
  (`public/dashboard.html` + `public/dashboard.js`).
- **Agent pages**: `public/alice.html` (agentId=1) and `public/bob.html`
  (agentId=0) load `public/js/agent-common.js` and
  `public/js/provider-openai-realtime.js`. Both pages are gated HTML — they
  receive `window.AGENT_AUTH_KEY` injected at request time so they can
  authenticate the socket handshake.
- **Two TTS modes**: realtime audio over WebRTC (default) or ElevenLabs
  streaming via `/tts/:agentId/stream` (when the agent page is loaded with
  `?tts=elevenlabs`). The `/tts/*` endpoint is rate-limited per-IP via a
  token bucket — see `.env.example` `ELEVENLABS_BURST`.
- **Package manager**: this repo is **pnpm-only**. Never run `npm install`
  (it breaks the workspace layout). Use `pnpm install` / `pnpm add`.
- **CLAUDE.md kill-terminal note**: long-running shell commands should use
  `isBackground: true` and the terminal should be killed after output is
  captured.

## What's already shipped (don't redo)

- `ADMIN_API_KEY` gating on all privileged HTTP routes and the `/space`
  socket handshake (constant-time compare, three transports: Bearer header,
  `X-API-Key` header, `?key=` query string)
- Inline server-rendered login form for gated HTML routes (`/alice`,
  `/bob`, etc.)
- Dashboard login modal + `sessionStorage` persistence
- Audit log: every `kickRequest` / `promptUpdate` / `userMessage` /
  `xspace:*` event writes a system entry into the transcript with the
  source IP, and broadcasts as `auditLog` to every dashboard
- Default `HOST=127.0.0.1` when no key is set, `0.0.0.0` when one is
- `/health`, `/x-tab-url`, `/space-info`, `/agent-config` endpoints
- ElevenLabs streaming TTS at `/tts/:agentId/stream` with per-IP rate-limit

## Definition of "done" per task

Each brief lists its own acceptance criteria. As a baseline, before claiming
a task is finished:

1. `node server.js` boots both with and without `ADMIN_API_KEY` set.
2. A dashboard tab can log in and see live transcript + audio meters.
3. No regressions in the two-agent broadcast flow (Alice + Bob can both
   connect their Realtime sessions and converse).
4. The audit log records the change.
5. Any new env var is documented in `.env.example`.
6. Any new endpoint has matching `requireAuth` (unless it's intentionally
   public — justify it in the PR).
