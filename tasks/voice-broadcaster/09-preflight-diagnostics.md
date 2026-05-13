# Task: Preflight Diagnostics CLI

## Context
Right now, when something goes wrong on the VM right before a show, it
takes 5–10 minutes to figure out which piece is broken: missing API
key, expired X cookies, ffmpeg not on PATH, PulseAudio sinks not
configured, OpenAI quota hit, ElevenLabs quota hit, puppeteer-core
missing, port 3000 occupied. Operators waste prep time triaging.

## Goal
A single command that runs every reasonable preflight check and prints
a clear pass/fail report:

```
$ pnpm preflight
✓ node 22.10.0 (>= 18)
✓ pnpm 9.x
✓ ffmpeg 6.0 on PATH
✓ pactl 16.1 on PATH
✓ puppeteer-core 22.x in node_modules
✓ .env loaded from /home/swarm/.env
✓ ADMIN_API_KEY set (64 chars)
✓ HOST=127.0.0.1
✓ OPENAI_API_KEY: valid (model: gpt-4o-realtime-preview-2024-12-17 reachable)
✓ ELEVENLABS_API_KEY: valid (47/100 voices visible)
✓ GROQ_API_KEY: valid
✗ X_AUTH_TOKEN: cookie expired ~3 days ago
  fix: re-export from x.com → DevTools → Cookies → auth_token
✓ port 3000 free
✓ port 9223 (chrome CDP) listening
✓ pulse sinks: 2 (virt_agent_out, default)
✓ pulse sink-inputs: 1 (chrome — sink: virt_agent_out)
✗ no chrome process attached to the X tab
  fix: ./scripts/open-x-tab.sh
✓ swarm-server.service: not running (ok — preflight is pre-start)

11 ok · 2 fail · 0 warn
Run with --fix to attempt auto-fixes for known issues.
```

## Why now
Every minute spent triaging at show time is a minute the show is dark.
This is the highest-leverage operator-time investment.

## Requirements

### Command surface
- `pnpm preflight` (or `node scripts/preflight.js`).
- Flags:
  - `--json` — machine-readable output for CI / Slack notifier.
  - `--strict` — exit code 1 on any failure; default exit 0 if at least
    `node`, `.env`, `ADMIN_API_KEY`, and chosen-provider keys pass.
  - `--fix` — runs auto-fixers where defined (renew npm modules, kill
    a stale process on :3000 with a y/N prompt). Do NOT auto-fix
    anything that requires a credential (cookies, API keys).
  - `--skip pulse,cdp` — run subset for laptop / Codespace usage.

### Check categories

| Category | Checks |
|---|---|
| Tooling | `node` >= 18, `pnpm` >= 8, `ffmpeg`, `pactl` (optional on non-Linux), `puppeteer-core` package present |
| Env | `.env` discoverable, `ADMIN_API_KEY` set, `HOST` sane vs. auth state, `AI_PROVIDER` valid |
| Provider auth | OpenAI (HEAD `/v1/models` returns 200), Anthropic, Groq, ElevenLabs — only check keys that are set |
| X auth | `X_AUTH_TOKEN` cookie present & not obviously expired (decode date if possible); OR `X_USERNAME` + `X_PASSWORD` set |
| Ports | 3000 free (or held by `swarm-server.service`), 9223 listening if CDP mode |
| PulseAudio | sinks exist, sink-inputs attached, no unexpected mute (skip on hosts without pactl) |
| Chrome CDP | `GET http://127.0.0.1:9223/json` succeeds; at least one tab matches x.com |
| File presence | `personalities.json` valid JSON (if task 06 done); `operators.json` valid (if task 01 done); `.cookies.json` for x-spaces module |

Implementation note: each check is an async function returning
`{ id, label, status: 'ok'|'fail'|'warn'|'skip', detail, fixHint }`.
Compose into a small runner that renders the table and respects flags.

### Auto-fix actions (--fix)
| Issue | Auto-fix |
|---|---|
| `port 3000 occupied by non-server process` | `lsof -ti:3000 \| xargs kill` after y/N prompt |
| `node_modules out of date` | `pnpm install` |
| `swarm-server.service running but preflight is supposed to be pre-start` | offer `sudo systemctl stop swarm-server.service` |
| `pactl sinks missing` | run `scripts/setup-pulse.sh` if it exists |

### Integration
- Run as a `pnpm prestart` hook for `node server.js` so a `pnpm start`
  attempt halts gracefully if anything is broken. Skip on
  `NODE_ENV=production` to avoid blocking systemd restarts (the service
  has its own readiness probe — see `/health`).
- Optional: emit metrics to a new `/preflight` endpoint that the
  dashboard health panel surfaces with a green "all checks pass" pill.

## Files to create / modify
- `scripts/preflight.js` (new) — main entry
- `scripts/preflight/checks/*.js` — one file per check group
  (`tooling.js`, `env.js`, `providers.js`, `xauth.js`, `ports.js`,
  `pulse.js`, `cdp.js`, `files.js`)
- `package.json` — add `"preflight": "node scripts/preflight.js"` and
  `"prestart": "node scripts/preflight.js --skip pulse,cdp || true"`
  (don't block dev `pnpm start`)
- `docs/preflight.md` — short doc on which checks exist and how to add
  one

## How to verify
1. `pnpm preflight` on a fresh Codespace (no pulse, no chrome) — pulse
   and cdp checks show `skip`, env checks fail loudly until `.env` is
   filled, then pass.
2. `pnpm preflight` on the VM during a healthy state — every category
   passes.
3. Provoke a failure: rename `.env` → preflight catches it and prints
   the `fix:` hint.
4. `pnpm preflight --json` → valid JSON, one entry per check.
5. `node server.js` after a fresh `.env` setup — `prestart` runs and
   gates the boot.

## Out of scope
- Continuous health monitoring. The preflight is a *snapshot*; runtime
  health lives at `/health`.
- A full TUI / curses interface. Plain ANSI rows are fine.
- Discord/Slack notifier integration. `--json` output makes that
  trivial to add later.

## Gotchas
- Don't make provider checks parallel-blast every key — bursty calls to
  five APIs from a single VM can trip rate-limits. Run sequentially with
  short timeouts (3s each).
- The `puppeteer-core` check is "present in node_modules", not "can
  launch chrome". The agent never launches its own Chrome on the VM —
  it connects via CDP.
- Don't read `.cookies.json` and print its contents. Just verify shape
  and that the JSON is valid.
- The X cookie expiry check should decode the `auth_token` JWT
  (it's not a JWT actually — it's an opaque Twitter token). Skip
  cryptographic verification; the only useful check is "do
  `GET https://x.com/i/api/...` with the cookie and confirm 200 vs 401".
  If you want this, run it; otherwise warn that expiry is unknown.
- Add `--no-color` for log piping; respect `NO_COLOR` env var.
