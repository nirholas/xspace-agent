# Spec 1 — Selector resilience for X UI automation

You are hardening the X-UI automation in `nirholas/xspace-agent`. Right now `automation/x-join-only.js`, `unmute-only.js`, and `unmute-dual.js` find buttons by scanning all `button`/`[role=button]` elements and matching on lowercased `aria-label` + `textContent`. This works but is **fragile** — when X renames a button or restructures the DOM, every automation script breaks at once and the system fails mid-Space.

Build a robust `SelectorEngine` that abstracts the matching logic, supports multiple fallback strategies, captures debug evidence on failure, and exposes a dry-run mode.

## What's there now

```
automation/
  vm-automation.js         single-account driver
  vm-automation-dual.js    dual-account driver
  x-join-only.js           X-tab-only join (no agent connect)
  unmute-only.js           clicks unmute on the X tab
  unmute-dual.js           clicks unmute on both X tabs
  reconnect-agent.js       reloads agent tab + clicks Connect
  open-agent2.js           opens agent2 in a new tab
  kick-loop.js             fires response.create on agent1
  update-prompts.js        session.update on both agents
```

Each script imports `puppeteer-core`, connects via CDP, has its own inline `click(page, needle)` helper that polls every 700-1500ms for buttons containing the needle text. This is duplicated 7 times across the codebase.

## What to build

A new module: `automation/selector-engine.js`. All other scripts get refactored to use it.

```js
// automation/selector-engine.js
class SelectorEngine {
  constructor(page, opts = {}) {
    this.page = page
    this.dryRun = !!opts.dryRun
    this.screenshotDir = opts.screenshotDir || "/tmp/selector-debug"
    this.log = opts.log || console.log
  }

  /**
   * Find an element using the first matching strategy.
   * strategies: array of {kind, value} pairs tried in order.
   *   {kind: "aria", value: "start listening"}        — case-insensitive substring
   *   {kind: "text", value: "Start listening"}         — exact textContent match
   *   {kind: "css", value: "[data-testid=join-btn]"}   — raw CSS selector
   *   {kind: "regex", value: /start\s+listen/i}        — regex on label or text
   *   {kind: "role-and-near", value: {role:"button", near:"Spaces"}} — heuristic
   */
  async findOne(strategies, { timeoutMs = 15000, minSize = 4 } = {}) { ... }
  async click(strategies, opts) { ... }
  async screenshot(label) { ... }   // for failure capture
  async dumpButtons(limit = 30) { ... } // returns list of {aria, text, role, rect}
}

// Standard recipes used across scripts
SelectorEngine.recipes = {
  startListening: [
    { kind: "aria", value: "start listening" },
    { kind: "text", value: "Start listening" },
    { kind: "regex", value: /^\s*listen|tune\s*in|join/i },
  ],
  requestToSpeak: [
    { kind: "aria", value: "request to speak" },
    { kind: "regex", value: /request|raise hand|ask to speak/i },
  ],
  unmute: [
    { kind: "aria", value: "unmute" },
    { kind: "aria", value: "turn on microphone" },
    { kind: "aria", value: "start speaking" },
    { kind: "regex", value: /^unmut|turn\s*on\s*m(ic|icrophone)|speak\s*now/i },
  ],
  leaveSpace: [
    { kind: "aria", value: "leave" },
    { kind: "regex", value: /leave|disconnect/i },
  ],
}
```

## Failure capture

When `findOne` times out:
1. Save a full-page screenshot to `${screenshotDir}/${timestamp}_${label}.png`.
2. Save a JSON dump of the first 40 visible buttons (aria-label, text, role, bounding rect).
3. Save a copy of `page.content()` (the HTML).
4. Log a single-line summary with the screenshot path.

These files let the operator (or another instance of an automation script) figure out the new DOM shape without re-running the failed scenario.

## Dry-run mode

When `new SelectorEngine(page, { dryRun: true })`:
- `findOne` returns the matched element handle but `click` only logs `[dry-run] would click: ${needle}` without dispatching the click.
- All seven scripts should accept a `--dry-run` CLI flag (and a `DRY_RUN=1` env var) and propagate it to the engine.

This lets the operator validate selectors against a live X tab without taking any actions.

## Health endpoint

Add `/selector-health` to `server.js` (gated with `requireAuth`):
- For each recipe in `SelectorEngine.recipes`, check whether the X tab on `:9223` currently has any matching element visible. Return `{ recipeName: boolean }`.
- Dashboard ([../prompts/INDEX.md](INDEX.md) spec #3) consumes this to show a "selectors OK" badge.

Implementation hint: import `puppeteer-core`, connect to the X Chrome (`http://127.0.0.1:9223`), get the spaces page, evaluate each recipe.

## Refactor targets (replace inline click helpers)

- `automation/x-join-only.js` — use `SelectorEngine.recipes.startListening` then `requestToSpeak`
- `automation/vm-automation.js` — same
- `automation/vm-automation-dual.js` — same (per account)
- `automation/unmute-only.js`, `unmute-dual.js` — use `SelectorEngine.recipes.unmute`
- `automation/reconnect-agent.js` — use a new recipe `agentConnectButton` (matches "connect" on the localhost agent page)
- `automation/open-agent2.js` — same recipe as above

After refactor each script should be ≤40 lines.

## Add: API-side selector strategy

X has a private GraphQL API used by their own clients. While reverse-engineering it isn't sanctioned and breaks easily, the `auth_token` + `ct0` cookies the operator already supplies are the same ones x.com uses for those calls. Add a fallback module `automation/x-api.js` that:

- Reads `X_AUTH_TOKEN` and `X_CT0` from env.
- Exposes `getSpace(spaceId)`, `joinAudioRoom(spaceId, sessionId)`, `requestSpeaker(spaceId)` against `https://api.x.com/`.
- Returns `{ ok: true, ...data }` on success, `{ ok: false, reason }` on auth failure / endpoint changed.

When the UI selector for "Request to speak" can't be found, the scripts try `x-api.js`'s `requestSpeaker` as a last resort before failing. Document any endpoint reverse-engineering inline so a future maintainer can update.

Important: this is best-effort. The UI path is canonical. Only use the API as a fallback when the UI is broken — don't bypass terms-of-service-relevant flows.

## Tests

`tests/selector-engine.test.js` (use Vitest — already a project dep):

```js
import { SelectorEngine } from "../automation/selector-engine.js"

test("findOne returns first matching strategy", async () => {
  const fakePage = makeFakePage([
    { aria: "Start listening", text: "Start listening", rect: { width: 100, height: 30 } },
  ])
  const e = new SelectorEngine(fakePage)
  const el = await e.findOne(SelectorEngine.recipes.startListening, { timeoutMs: 100 })
  expect(el).not.toBeNull()
})

test("findOne times out cleanly when no match", async () => { ... })

test("dryRun click logs without dispatching", async () => { ... })

test("dumpButtons returns visible buttons only", async () => { ... })
```

## Operator-facing changes

- `--dry-run` flag on every automation script
- New env var `SELECTOR_DEBUG_DIR` (defaults to `/tmp/selector-debug`)
- Document failure path in `docs/troubleshooting.md`: "if a recipe is silently failing, check the latest screenshot in $SELECTOR_DEBUG_DIR"

## Test plan

1. Manually break one selector recipe (e.g. set `startListening` to match a non-existent label). Verify the script:
   - Times out within `timeoutMs`
   - Saves a screenshot, JSON dump, and HTML snapshot
   - Returns non-zero exit code
   - Single-line log says where to look
2. Run all scripts against a live Space with `--dry-run`. Confirm no clicks land.
3. Run `curl -H "Authorization: Bearer $ADMIN_API_KEY" http://localhost:3000/selector-health`. All recipes that should be present return `true`.

## Don'ts

- Don't change the `automation/.env` shape — same X_AUTH_TOKEN / X_CT0 vars.
- Don't import puppeteer (full, with bundled Chromium) — stay on `puppeteer-core` (smaller dep).
- Don't add retries to the existing `findOne` timeout (already polls internally) — let callers handle the failure.
- Don't log full HTML content snapshots to stdout (only to file).

## When done

Open a PR titled `feat(spec-1): selector resilience + multi-strategy engine`. Include screenshots of the dry-run output and the failure-capture artifacts in the PR description.
