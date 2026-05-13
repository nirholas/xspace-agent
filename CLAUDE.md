# CLAUDE.md — xspace-agent Monorepo

**Kill every terminal** — always use `isBackground: true`, then kill the terminal after output is captured

## Git Identity
Always commit and push as nirholas. Use these flags on every `git commit`:
```
git -c user.name="nirholas" -c user.email="22895867+nirholas@users.noreply.github.com" commit ...
```
Never use a different author. The Co-Authored-By trailer should also use this identity.

## What This Project Is

**xspace-agent** is a TypeScript SDK and CLI that enables AI agents to autonomously join, listen, and speak in X (Twitter) Spaces. It supports multiple LLM providers (OpenAI, Claude, Groq), speech-to-text (Whisper), text-to-speech (ElevenLabs, OpenAI TTS), and multi-agent coordination — all driven by Puppeteer browser automation against the live X Spaces UI.

**Target**: Open-source developer tool. Proprietary (All Rights Reserved). Published to npm as `xspace-agent` (core SDK), `@xspace/server` (admin panel), `@xspace/cli` (CLI).

## Monorepo Layout

```
packages/
  core/          → xspace-agent         Main SDK. XSpaceAgent class, providers, audio, browser automation, FSM, intelligence layer.
  server/        → @xspace/server       Express + Socket.IO admin panel with auth, rate limiting, real-time agent control.
  cli/           → @xspace/cli          CLI tool (xspace-agent init|auth|join|start|dashboard).
  widget/        → UI widget components (early stage).
  create-xspace-agent/ → Project scaffolding template.

src/             → Legacy server code (Express + Socket.IO). Still functional via `npm run dev`. Being migrated into packages/.
agent-voice-chat/ → Standalone voice chat agent with its own test suite, OpenAPI spec, memory system.
x-spaces/       → Low-level Puppeteer automation scripts (JavaScript, legacy).
public/          → Frontend HTML/CSS/JS for dev server (npm run dev). NOT used in production.
  ⚠️  Railway production serves from packages/server/public/ — HTML changes must go there too.
examples/        → 10 runnable example projects (basic-join, multi-agent-debate, discord-bridge, etc.).
docs/            → 43 markdown docs covering architecture, deployment, API reference, and more.
docker/          → Prometheus + Grafana configs for monitoring profile.
```

## Quick Commands

```bash
# Development
npm run dev              # Start dev server (tsx watch src/server/index.ts)
npm run build            # tsc && vite build
npm run typecheck        # tsc --noEmit (server + client tsconfigs)
npm run lint             # eslint src/
npm run lint:fix         # eslint --fix
npm run format           # prettier --write

# Testing
npm run test             # Runs: cd packages/core && vitest run
cd packages/core && npx vitest run --coverage  # With coverage
cd packages/core && npx vitest run src/__tests__/e2e/  # E2E (needs API keys)

# Docker
npm run docker:build     # Build container
npm run docker:up        # Start agent container
npm run docker:up:monitoring  # Start with Prometheus + Grafana
```

## Architecture Overview

```
                    ┌──────────────────┐
                    │   X Space (live) │
                    └────────┬─────────┘
                             │ Puppeteer + CDP
                    ┌────────▼─────────┐
                    │ BrowserLifecycle │  Auth → Join → Request Speaker → Speak
                    │  (browser/)      │  Selector engine with self-healing CSS/text/aria strategies
                    └────────┬─────────┘
                             │ RTCPeerConnection audio hooks
                    ┌────────▼─────────┐
                    │  AudioPipeline   │  PCM capture → VAD → silence detection → WAV encoding
                    │  (audio/)        │  TTS audio injection back into Space
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
        ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
        │  STT      │ │  LLM      │ │  TTS      │  Provider factories (pipeline/)
        │ Whisper   │ │ OpenAI/   │ │ ElevenLabs│  Pluggable via config
        │ (Groq/OAI)│ │ Claude/   │ │ OpenAI/   │
        └───────────┘ │ Groq/     │ │ Browser   │
                      │ Custom    │ └───────────┘
                      └───────────┘
              │
        ┌─────▼──────────────────────┐
        │  Intelligence Layer        │  Speaker ID, topic tracking, sentiment,
        │  (intelligence/)           │  context management, prompt building, persistence
        └────────────────────────────┘
              │
        ┌─────▼──────────────────────┐
        │  Turn Management (turns/)  │  Decision engine, interruption handling,
        │  + FSM (fsm/)             │  adaptive silence detection, response pacing
        └────────────────────────────┘
```

### Key Classes

| Class | File | Purpose |
|-------|------|---------|
| `XSpaceAgent` | `packages/core/src/agent.ts` | Main entry point. Orchestrates browser, audio, LLM, and turn management. |
| `AgentTeam` | `packages/core/src/team.ts` | Multi-agent coordination. Multiple AI personalities sharing one browser session. |
| `BrowserLifecycle` | `packages/core/src/browser/lifecycle.ts` | Puppeteer browser launch, login, Space join/leave lifecycle. |
| `AudioPipeline` | `packages/core/src/audio/pipeline.ts` | Audio capture, VAD, silence detection, encoding pipeline. |
| `ConversationManager` | `packages/core/src/conversation.ts` | Message history, token counting, context windowing. |
| `StateMachine` | `packages/core/src/fsm/machine.ts` | Generic FSM engine. Used by agent and team state machines. |
| `SelectorEngine` | `packages/core/src/browser/selector-engine.ts` | Self-healing CSS selectors for X's DOM. Tries multiple strategies (CSS, text, aria). |
| `ProviderRouter` | `packages/core/src/providers/router.ts` | Intelligent LLM routing across multiple providers. |
| `CostTracker` | `packages/core/src/providers/cost-tracker.ts` | Per-provider cost monitoring. |
| `PluginManager` | `packages/core/src/plugins/manager.ts` | Plugin system for extending agent behavior. |
| `TurnCoordinator` | `packages/core/src/turns/coordinator.ts` | Multi-agent turn-taking orchestration. |
| `DecisionEngine` | `packages/core/src/turns/decision-engine.ts` | Should-I-respond decision logic based on conversation signals. |

### Data Flow: Voice Input → AI Response → Voice Output

1. **Capture**: Puppeteer hooks `RTCPeerConnection` in the X Spaces page, captures PCM audio from incoming tracks.
2. **VAD**: `VoiceActivityDetector` detects speech vs silence. After silence threshold (default 1.5s), audio chunk is finalized.
3. **STT**: Audio chunk sent to Whisper (Groq or OpenAI). Returns transcribed text.
4. **Intelligence**: `SpeakerIdentifier` attributes text to a speaker. `TopicTracker` and `detectSentiment` enrich metadata. `ContextManager` windows the conversation history.
5. **Decision**: `DecisionEngine` evaluates whether to respond (directly addressed? is it a question? topic relevance?).
6. **LLM**: `PromptBuilder` constructs the prompt. Provider streams response text.
7. **TTS**: Response text synthesized to MP3 via ElevenLabs/OpenAI/browser.
8. **Injection**: Audio injected back into Space via `injectAudio()` through the browser's WebRTC connection.

### Provider Pattern

All providers implement standardized interfaces (`LLMProvider`, `STTProvider`, `TTSProvider` in `packages/core/src/types.ts`). Each has:
- `streamResponse()` / `transcribe()` / `synthesize()` — core operations
- `checkHealth()` — connectivity and latency check
- `getMetrics()` — request counts, success rates, latency, token usage
- `estimateCost()` — USD cost estimation

Created via factory functions: `createLLM(config)`, `createSTT(config)`, `createTTS(config)` in `packages/core/src/pipeline/`.

### State Machine

Agents use a finite state machine (`packages/core/src/fsm/`):
```
idle → launching → authenticating → joining → listening → speaking → leaving → stopped
                                                    ↑                    ↓
                                                    └────────────────────┘
```

Teams have a separate FSM: `idle → starting → active → stopping → stopped`.

### Middleware Pipeline

Six interception points in the audio processing pipeline:
`before:stt` → `after:stt` → `before:llm` → `after:llm` → `before:tts` → `after:tts`

Middleware handlers receive typed data for their stage and can transform or abort (return null).

## Error Handling

All SDK errors extend `XSpaceError` (in `packages/core/src/errors.ts`) with:
- `code` — machine-readable (e.g., `AUTH_FAILED`, `SPACE_NOT_FOUND`, `PROVIDER_ERROR`)
- `message` — human-readable description
- `hint` — actionable fix suggestion
- `docsUrl` — optional link to relevant docs

Specific error classes: `AuthenticationError`, `SpaceNotFoundError`, `SpaceEndedError`, `BrowserConnectionError`, `SpeakerAccessDeniedError`, `ProviderError`, `ConfigValidationError`, `SelectorBrokenError`.

## TypeScript Configuration

- **Target**: ES2022, **Module**: NodeNext, **Strict**: true
- **Root tsconfig.json**: Server code (src/ excluding src/client)
- **tsconfig.client.json**: Browser/client code
- Two separate `--noEmit` checks in `npm run typecheck`
- Packages use their own tsconfig extending the base

## Testing

- **Framework**: Vitest with `@vitest/coverage-v8`
- **Location**: `packages/core/tests/` and `packages/core/src/__tests__/`
- **CI matrix**: Node 18, 20, 22
- **Coverage targets**: ~80% statements/functions/lines, ~70% branches
- **E2E tests**: Only run on `main` push (require API key secrets)
- **Test timeout**: 10 seconds
- Tests use mock providers, Socket.IO test helpers, and test app factories

## Commit Conventions

- **Style**: Conventional commits — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **PR titles**: Validated by `amannn/action-semantic-pull-request` in CI

## CI Pipeline (.github/workflows/ci.yml)

1. **lint** — ESLint
2. **typecheck** — tsc --noEmit (server + client)
3. **test** — Vitest on Node 18/20/22, coverage upload on Node 20
4. **build** — Depends on lint + typecheck + test passing. Verifies package size and exports.
5. **e2e** — Main branch only, requires API key secrets
6. **security-audit** — `npm audit --audit-level=high`
7. **dependency-review** — On PRs only

## Environment Variables

**Required for X Spaces**:
- `X_AUTH_TOKEN` + `X_CT0` (cookie auth, recommended) OR `X_USERNAME` + `X_PASSWORD`

**Required for AI** (at least one):
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`

**Optional**:
- `AI_PROVIDER` — `openai` | `openai-chat` | `claude` | `groq` (default: `openai`)
- `STT_PROVIDER` — `groq` | `openai` (default: `groq`)
- `TTS_PROVIDER` — `elevenlabs` | `openai` | `browser` (auto-detected)
- `ELEVENLABS_API_KEY` — Required if TTS_PROVIDER=elevenlabs
- `ADMIN_API_KEY` — Required for admin panel authentication
- `BROWSER_MODE` — `managed` | `connect` (default: `managed`)
- `PORT` — Server port (default: `3000`)
- `HEADLESS` — Run Puppeteer headless (default: `true`)

Full reference: `.env.example` (215 lines with comments).

## Legacy Code

The `src/` directory contains the original monolithic server implementation. It works via `npm run dev` (TypeScript) or `npm run start:legacy` (JavaScript `server.js`). This code is being progressively migrated into the `packages/` monorepo structure. When working on new features, prefer `packages/core/` over `src/`.

The `agent-voice-chat/` directory is a standalone voice chat agent with its own test suite (`vitest`), OpenAPI spec (`openapi.json`), memory system (vector embeddings), and conversation archiving (gzip). It has separate routing, middleware, and error handling patterns.

## Docker

Multi-stage Dockerfile: deps → builder → runtime (node:20-slim + Chromium).
- Health check: `GET /health` every 30s
- Persistent volumes: `/app/cookies`, `/app/data`
- Requires 2GB shared memory for Chromium (`--shm-size=2gb`)
- Compose profiles: default (agent only), `with-redis`, `with-monitoring` (Prometheus + Grafana)

## Key Patterns for Contributing

1. **New LLM provider**: Implement `LLMProvider` interface, add to `createLLM()` factory in `packages/core/src/pipeline/llm.ts`.
2. **New TTS/STT provider**: Same pattern — implement interface, add to factory.
3. **New intelligence feature**: Add to `packages/core/src/intelligence/`, wire into `XSpaceAgent`.
4. **New middleware**: Use `agent.use('stage', handler)` pattern or create a Plugin.
5. **Browser selector breaks**: Update `packages/core/src/browser/selectors.ts`. The `SelectorEngine` tries multiple strategies, so add alternatives rather than replacing.
6. **New API endpoints**: Add to `packages/server/src/` with Zod validation and auth middleware.
7. **New CLI command**: Add to `packages/cli/src/commands/` using Commander.js.

## What Not to Do

- Don't commit `.env` files, API keys, or auth tokens.
- Don't modify `server.js` — it's legacy. Work in `packages/` or `src/` TypeScript.
- Don't add database dependencies — persistence is file-based by design (JSON + gzip).
- Don't break the provider interface contracts — many things depend on `streamResponse()`, `checkHealth()`, `getMetrics()`, `estimateCost()`.
- Don't hardcode X Space CSS selectors — use `SelectorEngine` with multiple fallback strategies.
- Don't skip the FSM — agent lifecycle transitions go through the state machine, not ad-hoc flags.


