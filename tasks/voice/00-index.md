# Voice Agent — Parallel Task Pack

Tasks specific to the **live X Spaces voice agent** stack: the dual-agent system at
`public/server-agent1.html` + `public/server-agent2.html` running on top of
`public/js/provider-openai-realtime.js`, the legacy `server.js`, the
`providers/openai-realtime.js` session minter, and the new ElevenLabs streaming
TTS endpoints (`/tts/:id/stream`, `/voices`).

Distinct from the broader enterprise roadmap in `tasks/01-…` through `tasks/30-…` —
these are tied to the voice-agent's production-readiness, not the SDK/dashboard
work.

Each `.md` is self-contained: drop it into a fresh chat as the prompt, and the
agent has everything it needs to ship.

## Wave 1 — fully parallel (no file conflicts)

Run all of these simultaneously in separate chats.

| # | File | Touches | Effort |
|---|------|---------|--------|
| 01 | `01-realtime-client-tests.md` | `tests/` (new) | M |
| 02 | `02-tts-server-tests.md` | `tests/` (new) | M |
| 08 | `08-organize-dual-agent-scripts.md` | loose root scripts | S |
| 09 | `09-x-spaces-selector-audit.md` | `x-spaces/` | M |
| 10 | `10-packages-server-port.md` | `packages/server/` | L |
| 12 | `12-cost-dashboard-panel.md` | `public/dashboard.*` | M |
| 13 | `13-preview-voice-button.md` | `public/server-agent*.html` | S |

## Wave 2 — conflicting, run sequentially

These all touch `server.js`. Run **one at a time**, in the order shown.

| # | File | Touches | Effort |
|---|------|---------|--------|
| 06 | `06-cost-guardrails-and-metrics.md` | `server.js` (additive) | M |
| 07 | `07-server-hardening.md` | `server.js` (top of file) | S |

## Wave 3 — conflicting, run sequentially

These all touch `public/js/provider-openai-realtime.js`. Run **one at a time**.
Each builds on the previous, so the recommended order is 05 → 03 → 04 → 11.

| # | File | Touches | Effort |
|---|------|---------|--------|
| 05 | `05-realtime-model-update.md` | `providers/openai-realtime.js`, `public/js/provider-openai-realtime.js` | S |
| 03 | `03-per-sentence-streaming.md` | `public/js/provider-openai-realtime.js` | M |
| 04 | `04-barge-in-and-reconnect.md` | `public/js/provider-openai-realtime.js`, `public/js/agent-common.js` | M |
| 11 | `11-websocket-streaming-tts.md` | `public/js/provider-openai-realtime.js`, `server.js` | L |

## Standing rules every agent must follow

1. **Package manager is pnpm.** Never run `npm install`. Use `pnpm i`, `pnpm -F <pkg> add`, etc.
2. **`server.js` is the live legacy entry point.** Don't delete or refactor it — additive changes only. The deprecation warning is fine to leave.
3. **The ElevenLabs API key (`ELEVENLABS_API_KEY`) never leaves the server.** Always proxy. Never inject into HTML.
4. **All operator HTML routes** go through `requireAuth` + `sendWithAuthInjection`. New operator pages must be added to the `GATED_HTML` set in `server.js`.
5. **`/tts/:id/stream` and `/voices`** are auth-gated and rate-limited. Don't bypass.
6. **Background processes only.** Per `CLAUDE.md`: always launch with `isBackground: true` and kill the terminal after capturing output. Never block on `pnpm run dev`.
7. **No new dependencies** without a one-line justification in the PR description.
8. **No emojis** in code or commits unless explicitly requested.
