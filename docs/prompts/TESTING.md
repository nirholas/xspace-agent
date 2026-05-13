# Spec 6 — Integration tests + CI

`nirholas/xspace-agent` has zero tests for the live-server path. Refactoring or adding features risks silent regressions. Build a solid test suite plus CI on GitHub Actions.

## What's there now

- `package.json` has `vitest` and `@vitest/coverage-v8` as dev deps but no test scripts.
- A few legacy tests in `packages/core/src/__tests__/` are for the unused SDK path. Ignore those.

## Coverage targets

| Area | What to cover |
|---|---|
| `server.js` HTTP routes | All endpoints under auth + unauth cases |
| `server.js` Socket.IO events | Agent connect/disconnect, statusChange, textComplete → forwarding logic |
| `providers/` | Provider factory selects correctly; each provider's `createSession`/`stream` works against a mock |
| `automation/selector-engine.js` (after spec-1) | All recipes, fallback chains, dry-run mode |
| End-to-end | Mocked OpenAI + mocked X Chrome — simulate audio in → verify response out |

Target ≥80% line coverage on `server.js` and `providers/`. ≥60% on `automation/`.

## Test layout

```
tests/
  setup.js                        global vitest setup (loads fixtures, mocks fetch)
  helpers/
    fake-openai.js                local server that mimics /v1/realtime/* endpoints
    fake-elevenlabs.js            mimics /v1/text-to-speech/*/stream
    fake-x.js                     mimics x.com endpoints (cookie set + minimal Space DOM)
    socket-client.js              authenticated Socket.IO client for tests
    auth.js                       helpers to mint a test ADMIN_API_KEY
  unit/
    auth.test.js
    requireAuth.test.js
    ttsRoute.test.js
    sessionRoute.test.js
    socketKickRoute.test.js
    selectorEngine.test.js
  integration/
    twoAgentLoop.test.js          full server-up, both agents simulated, forwarder + claim-token verified
    ttsSwitching.test.js          live provider swap mid-session
    personaSwap.test.js           live persona swap mid-session
    healthMonitor.test.js         watchdog detects + recovers
  e2e/
    spaceJoin.test.js             puppeteer launches real Chrome (headless), joins fake-x, ends up "in Space"
```

## Mock OpenAI

The Realtime API is fully WebRTC + WebSocket. A real mock is heavy — instead, intercept at the SDK boundary.

```js
// tests/helpers/fake-openai.js
const express = require("express")
function start(port = 18080) {
  const app = express()
  app.use(express.json())
  // Ephemeral key minting
  app.post("/v1/realtime/client_secrets", (req, res) => {
    res.json({
      value: `ek_test_${Date.now()}`,
      expires_at: Math.floor(Date.now() / 1000) + 60,
      session: { id: "sess_test", model: req.body?.session?.model || "gpt-realtime" },
    })
  })
  // SDP exchange — return a minimal valid SDP answer
  app.post("/v1/realtime/calls", (req, res) => {
    res.setHeader("Content-Type", "application/sdp")
    res.send(MINIMAL_VALID_SDP)
  })
  // TTS
  app.post("/v1/audio/speech", (req, res) => {
    res.setHeader("Content-Type", "audio/wav")
    res.send(FIXTURE_WAV_BYTES)
  })
  return app.listen(port)
}
module.exports = { start }
```

Bend `OPENAI_API_BASE` env var so server / providers use the fake. Add a check in `providers/openai-realtime.js` to honor `process.env.OPENAI_API_BASE` (defaulting to `https://api.openai.com`).

## Mock ElevenLabs

```js
// tests/helpers/fake-elevenlabs.js
const express = require("express")
function start(port = 18081) {
  const app = express()
  app.use(express.json())
  app.post("/v1/text-to-speech/:voiceId/stream", (req, res) => {
    res.setHeader("Content-Type", "audio/mpeg")
    res.write(FIXTURE_MP3_FRAME)
    setTimeout(() => res.end(), 100) // simulate streaming latency
  })
  app.get("/v1/voices", (req, res) => res.json({ voices: [{ voice_id: "test", name: "Test Voice" }] }))
  return app.listen(port)
}
```

Server reads `ELEVENLABS_API_BASE` env var (defaulting to `https://api.elevenlabs.io`).

## Mock X / Realtime audio

End-to-end tests run a headless Chrome against a `tests/fixtures/fake-x-space.html` that:
- Has Start listening / Request to speak / Unmute buttons with the same labels
- Plays back a pre-recorded WAV of "what does three.ws do?" via `<audio>`
- Routes via standard PulseAudio null sinks (only on Linux CI runners; mark these tests as Linux-only via vitest tags)

## CI: GitHub Actions

`.github/workflows/ci.yml`:

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  lint-and-type:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci --no-audit --no-fund
      - run: npm run lint
      - run: npm run typecheck

  unit:
    runs-on: ubuntu-latest
    strategy:
      matrix: { node: [18, 20, 22] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }}, cache: npm }
      - run: npm ci --no-audit --no-fund
      - run: npm test -- --reporter=verbose unit
      - if: matrix.node == 20
        uses: codecov/codecov-action@v4
        with: { files: ./coverage/coverage-final.json }

  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci --no-audit --no-fund
      - name: Install PulseAudio + Chrome libs
        run: |
          sudo apt-get update
          sudo apt-get install -y pulseaudio pulseaudio-utils xvfb \
            libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 \
            libatspi2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
            libgbm1 libnss3 libpango-1.0-0 libgtk-3-0t64 libdrm2 libasound2t64
      - run: npm test -- --reporter=verbose integration

  e2e:
    runs-on: ubuntu-latest
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci --no-audit --no-fund
      - name: System setup
        run: |
          sudo apt-get update
          sudo apt-get install -y pulseaudio xvfb chromium-browser
      - run: npm test -- --reporter=verbose e2e
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: e2e-screenshots, path: tests/e2e/screenshots/ }
```

## package.json scripts

```json
{
  "scripts": {
    "test": "vitest run --reporter=verbose",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:unit": "vitest run unit",
    "test:integration": "vitest run integration",
    "test:e2e": "vitest run e2e",
    "lint": "eslint . --ext .js,.ts",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

## Example: forwarder + claim-token test

```js
// tests/integration/twoAgentLoop.test.js
import { startServer } from "./helpers/server.js"
import { connectAgentClient } from "./helpers/socket-client.js"

test("agent A's textComplete forwards to agent B as textToAgent when B is idle", async () => {
  const srv = await startServer({ port: 0 })
  const agentA = await connectAgentClient(srv.url, 0)
  const agentB = await connectAgentClient(srv.url, 1)

  await agentA.emit("agentConnect", { agentId: 0 })
  await agentB.emit("agentConnect", { agentId: 1 })
  await agentA.emit("statusChange", { agentId: 0, status: "idle" })
  await agentB.emit("statusChange", { agentId: 1, status: "idle" })

  const bGot = waitForEvent(agentB, "textToAgent")
  await agentA.emit("textComplete", { agentId: 0, text: "hello swarm2", messageId: "m1" })
  const ev = await bGot
  expect(ev.text).toBe("hello swarm2")
  expect(ev.from).toMatch(/swarm/i)

  await srv.close()
})

test("claim-token: when A starts speaking, B receives cancelResponse", async () => {
  const srv = await startServer({ port: 0 })
  const agentA = await connectAgentClient(srv.url, 0)
  const agentB = await connectAgentClient(srv.url, 1)

  await agentA.emit("agentConnect", { agentId: 0 })
  await agentB.emit("agentConnect", { agentId: 1 })

  const bGot = waitForEvent(agentB, "cancelResponse")
  await agentA.emit("statusChange", { agentId: 0, status: "speaking" })
  const ev = await bGot
  expect(ev.reason).toMatch(/floor/i)

  await srv.close()
})
```

## Snapshot fixtures

`tests/fixtures/`:
- `minimal-sdp.txt` — known-good SDP answer body
- `fixture.wav` — short silent WAV for TTS mock
- `fixture.mp3` — short silent MP3 frame
- `fake-x-space.html` — fake X Space DOM for E2E

## Lint + format

ESLint + Prettier configs (if not already present). Pre-commit hook via `husky` + `lint-staged` runs lint + tests on changed files.

## Test plan for this spec itself

1. `npm test:unit` passes locally on Node 20.
2. PR opens CI runs: lint-and-type, unit on 18/20/22, integration. All green.
3. Coverage badge shows ≥80% on server.js and providers/.
4. Forced regression test: temporarily break the forwarder gating, confirm `twoAgentLoop.test.js` fails with a clear message.
5. E2E run on main passes (Chromium + Xvfb).

## Don'ts

- Don't write tests against the real OpenAI / ElevenLabs APIs. Mock everything.
- Don't put real API keys in fixtures or .env.test.
- Don't bypass `requireAuth` in tests via env tricks; instead set `ADMIN_API_KEY=test-key` and pass it as a Bearer header.
- Don't skip flaky tests with `.skip` — fix them or delete them.

## When done

PR `feat(spec-6): integration tests + CI`. PR body shows: coverage report, the GitHub Actions runs (all green), and a list of every test that exists.
