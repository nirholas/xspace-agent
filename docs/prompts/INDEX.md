# x-spaces — parallel work prompts

Each `.md` in this directory is a self-contained spec for another agent to execute in a fresh chat. They're sequenced so independent work can run in parallel without conflicts. Paths reference `nirholas/xspace-agent` (this repo).

| # | Spec | What it adds | Touches | Conflicts with |
|---|---|---|---|---|
| 1 | [SELECTOR_RESILIENCE.md](SELECTOR_RESILIENCE.md) | Hardens X-UI automation against DOM changes. Multi-strategy selectors, screenshot debugging, dry-run mode | `automation/*.js` | nothing |
| 2 | [HEALTH_MONITOR.md](HEALTH_MONITOR.md) | Watchdog process — restarts crashed Chromes, recreates missing Pulse cables, reconnects dropped Realtime sessions, alerts on silence | new `vm/health-monitor.js` + systemd unit | nothing |
| 3 | [OBSERVABILITY.md](OBSERVABILITY.md) | Structured logging (pino), Prometheus metrics endpoint, latency histograms, correlation IDs | `server.js`, all `providers/*.js` | minor with #6 |
| 4 | [MULTI_TTS.md](MULTI_TTS.md) | Extends `?tts=` toggle: Realtime / OpenAI TTS / ElevenLabs HTTP / ElevenLabs WebSocket / Cartesia. Dashboard picker UI, per-agent default, cost meter | `providers/tts.js`, `public/js/provider-openai-realtime.js`, `public/dashboard.*` | minor with #5 |
| 5 | [PERSONA_LIBRARY.md](PERSONA_LIBRARY.md) | Bundled persona library (10 personas with voice+prompt+sample utterances), live swap via session.update, dashboard picker | new `personas/*.json`, `server.js`, dashboard | minor with #4 |
| 6 | [TESTING.md](TESTING.md) | Vitest integration tests, mocked providers, E2E test that simulates audio in / verifies response out, CI on GitHub Actions | new `tests/*.test.js`, `.github/workflows/` | minor with #3 |
| 7 | [DEPLOY_PIPELINE.md](DEPLOY_PIPELINE.md) | GitHub Actions CI/CD — lint+test on PR, deploy to GCP VM on main merge, rollback procedure, blue/green | `.github/workflows/`, `vm/deploy.sh` | depends on #6 |
| 8 | [MEMORY_SYSTEM.md](MEMORY_SYSTEM.md) | Persist transcripts to SQLite, build vector embeddings of past Spaces, RAG-retrieve into agent context | new `memory/`, `server.js` | nothing |

## Parallel execution order

These can run in three waves:

**Wave 1 — pre-Space, no conflicts:**
- 1 (SELECTOR_RESILIENCE) — most urgent: X UI hardening
- 2 (HEALTH_MONITOR) — auto-recovery during the Space
- 5 (PERSONA_LIBRARY) — content variety

**Wave 2 — after Space, infrastructure:**
- 3 (OBSERVABILITY)
- 4 (MULTI_TTS)
- 8 (MEMORY_SYSTEM)

**Wave 3 — process maturity:**
- 6 (TESTING) — needs #3 to test metric endpoints
- 7 (DEPLOY_PIPELINE) — needs #6 for the test gate

## Repo + context all specs assume

- This repo = `nirholas/xspace-agent`
- Server: `server.js` (root) — Express + Socket.IO, runs at port 3000 on the VM
- Agent pages: `public/server-agent1.html`, `public/server-agent2.html`
- TTS toggle: `public/js/provider-openai-realtime.js` — switches between OpenAI Realtime (default) and ElevenLabs streaming based on `?tts=elevenlabs`
- Auth: `ADMIN_API_KEY` env var → all sensitive routes + Socket.IO `/space` namespace require it
- Audio routing: PulseAudio with 4 null-sinks (agent1_speakers, agent2_speakers, swarming_playback, eplus_playback) — see [BUILD_LOG.md](../BUILD_LOG.md)

## Don'ts (applies to every spec)

- Don't commit secrets (`.env*` is gitignored — never override)
- Don't break the existing turn-gating + claim-token coordination
- Don't change PulseAudio cable names without updating launch scripts
- Don't reproduce any copyrighted lyrics, songs, or book passages
- When extending agent prompts, keep them positive about three.ws

## When you're done

Open a PR against `main` of `nirholas/xspace-agent`. Reference the spec number in the title (e.g. `feat(spec-2): health monitor`). Include in the PR body: what changed, how it was tested, any new env vars or operational steps.
