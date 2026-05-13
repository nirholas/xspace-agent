# Preflight Diagnostics

Run all health checks before starting the agent:

```
pnpm preflight
```

Prints a pass/fail report covering eight check groups. Use it before shows to catch broken API keys, expired cookies, missing tools, or port conflicts.

## Flags

| Flag | Description |
|---|---|
| `--json` | Machine-readable JSON output (one object per check). Useful for CI or Slack notifiers. |
| `--strict` | Exit code 1 on any `fail` result. Default exits 0 if node, `.env`, `ADMIN_API_KEY`, and at least one provider key pass. |
| `--fix` | Run auto-fixers with y/N prompts. See [Auto-fix actions](#auto-fix-actions). |
| `--skip <groups>` | Comma-separated list of check groups to skip (e.g. `--skip pulse,cdp`). Use for laptop/Codespace runs without PulseAudio or Chrome. |
| `--no-color` | Disable ANSI color. Honored automatically when `NO_COLOR` env var is set. |

## Check Groups

| Group | What it checks |
|---|---|
| `tooling` | node ≥ 18, pnpm ≥ 8, ffmpeg on PATH, pactl on PATH (optional), puppeteer-core in node_modules |
| `env` | `.env` file present, `ADMIN_API_KEY` set, `HOST` sane, `PORT`, `AI_PROVIDER`/`STT_PROVIDER`/`TTS_PROVIDER` valid values |
| `providers` | Live API check for each key that is set: OpenAI, Anthropic, Groq, ElevenLabs. Runs sequentially (3s timeout each) to avoid rate-limit bursts. |
| `xauth` | `X_AUTH_TOKEN` cookie live-verified via `GET /1.1/account/verify_credentials.json`; or `X_USERNAME`+`X_PASSWORD` present as fallback. |
| `ports` | `PORT` (default 3000) free; port 9223 listening if `BROWSER_MODE=connect`. |
| `pulse` | PulseAudio sinks exist, sink-inputs attached, no unexpected mute. Skipped automatically when `pactl` is not on PATH. |
| `cdp` | `GET http://127.0.0.1:9223/json` reachable; at least one tab matches x.com. Skipped via `--skip cdp`. |
| `files` | `personalities.json` valid JSON (if present), `operators.json` valid (if present), `.cookies.json` shape check (no contents printed). |

## Auto-fix Actions

Pass `--fix` to attempt these repairs interactively:

| Trigger | Action |
|---|---|
| Port occupied by non-server process | `lsof -ti:<port> \| xargs kill` after y/N |
| `puppeteer-core` missing | `pnpm install` |
| `swarm-server.service` running | `sudo systemctl stop swarm-server.service` after y/N |
| PulseAudio sinks missing | run `scripts/setup-pulse.sh` if it exists |

Auto-fix **never** touches credentials. Cookie and API key problems require manual action.

## Adding a New Check

1. Open or create the relevant file in `scripts/preflight/checks/`.
2. Export an `async function run_checks()` that returns an array of result objects:

```js
import { check } from '../runner.js';

export async function run_checks() {
  return [
    check({
      id: 'my_check',        // unique snake_case id
      label: 'my thing works',
      status: 'ok',          // 'ok' | 'fail' | 'warn' | 'skip'
      detail: 'optional extra line printed below the label',
      fixHint: 'how to fix it',
      autoFix: 'action_key', // optional — enables --fix for this result
    }),
  ];
}
```

3. Register the group in `scripts/preflight/runner.js` inside `CHECK_GROUPS`.

## Prestart Hook

`pnpm start:legacy` runs preflight automatically via the `prestart:legacy` script in `package.json`. It uses `--skip pulse,cdp` and exits 0 even on failure so a broken preflight never blocks a systemd restart. The service's own `/health` endpoint is the runtime health probe.

For strict gating (e.g. manual start scripts), call explicitly:

```bash
node scripts/preflight.js --strict || exit 1
node server.js
```
