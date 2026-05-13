# Voice Task 09 — X Spaces selector audit + self-healing strategies

## Context

`packages/core/src/browser/selectors.ts` (and the legacy equivalents under
`x-spaces/`) contain the Puppeteer selectors used to click around the X
Spaces UI: "Join Space", "Request Speaker", "Mute", "Leave", etc.

X (Twitter) ships UI changes frequently. When a selector breaks, the agent
silently sits in a Space without speaking. The `SelectorEngine` already
supports multiple strategies (CSS, text, ARIA) — what we need is:

1. An **audit** that confirms which selectors still work today.
2. **Fresh fallback strategies** added wherever a selector has only one entry.
3. A **doctor script** that operators can run to verify selectors before
   joining a critical Space, so we catch breakage before it matters.

## Requirements

### 1. Selector inventory

Build a list of every selector currently in use. Sources:

- `packages/core/src/browser/selectors.ts`
- `x-spaces/` (legacy Puppeteer scripts — grep for `page.$(`, `page.click(`,
  `waitForSelector`).

Output as `x-spaces/SELECTORS.md` — one row per action with: action name,
current primary selector, fallback selectors, last-verified date.

### 2. Live audit

Write a script `x-spaces/scripts/audit-selectors.js`:

1. Connects to a logged-in Chrome via CDP (`BROWSER_MODE=connect`, port 9222 —
   the existing pattern).
2. Opens a known Space URL (env: `AUDIT_SPACE_URL`).
3. For each selector in the inventory, calls a small helper that returns
   `{ found: bool, strategy: "css"|"text"|"aria", element: handleOrNull }`.
4. Prints a table:

```
action               primary  fallback1  fallback2  status
join-space-button    ✓        —          —          OK
request-speaker      ✗        ✓ (aria)   —          DEGRADED → primary broken
mute-mic             ✗        ✗          ✗          BROKEN → manual fix needed
```

Exits with non-zero if any are `BROKEN`.

This must NOT join the Space as a speaker or otherwise interact in a way
that disrupts the live audience — read-only DOM probes only. Skip selectors
whose primary action is destructive (e.g. "leave"); audit them by inspecting
the button's existence, not by clicking.

### 3. Add fallback strategies

For every selector that has only one entry today, add at least one fallback.
Pattern:

```ts
{
  name: "request-speaker",
  strategies: [
    { kind: "css",  selector: 'button[data-testid="acceptSpeakerRequest"]' },
    { kind: "aria", role: "button", name: /request to speak/i },
    { kind: "text", text: /request to speak/i },
  ],
}
```

The `SelectorEngine` already supports these strategies — confirm by reading
its implementation. If `aria` or `text` strategies aren't yet supported,
add them (small, well-scoped extension). See
`packages/core/src/__tests__/selector-engine.test.ts` for the existing test
shape.

### 4. Telemetry hook

Emit a `selectorFallback` event on `XSpaceAgent` whenever a non-primary
strategy succeeds. Wire it through to whatever observability you have
(stub-OK if there's no consumer yet). Format:

```
{
  action: "request-speaker",
  primaryFailed: true,
  successfulStrategy: "aria",
  timestamp: 1234567890
}
```

This gives us early warning when a primary breaks in the wild.

### 5. CLI wrapper

Add a script entry to the relevant `package.json`:

```json
"scripts": {
  "selectors:audit": "node x-spaces/scripts/audit-selectors.js"
}
```

So operators can run `pnpm selectors:audit` before kicking off a live session.

## Files to Create

- `x-spaces/SELECTORS.md`
- `x-spaces/scripts/audit-selectors.js`

## Files to Modify

- `packages/core/src/browser/selectors.ts` — add fallbacks for under-covered
  actions.
- `packages/core/src/browser/selector-engine.ts` — only if missing the `aria`
  or `text` strategy; add minimally with tests.
- `packages/core/src/__tests__/selector-engine.test.ts` — add tests for new
  strategies if you added any.
- `package.json` — `selectors:audit` script.

## Files NOT to Touch

- `server.js`
- `public/**` (browser-side UI is unrelated)
- The EL TTS code

## Acceptance Criteria

- [ ] `pnpm selectors:audit` runs end-to-end against a live logged-in Space
      with `AUDIT_SPACE_URL` set. Exit 0 means all selectors found at least
      one working strategy. Exit 1 lists the broken ones.
- [ ] Every action in `selectors.ts` has at least 2 fallback strategies.
- [ ] `x-spaces/SELECTORS.md` is current and dated.
- [ ] Existing core tests still pass: `cd packages/core && pnpm test`.
- [ ] No regression in the live agent: hooking up the agent to a real Space
      still joins and speaks normally.

## Don'ts

- Don't change the `SelectorEngine`'s public API beyond adding strategies.
  Many call sites depend on the current shape.
- Don't audit by *clicking* destructive buttons. Inspect their presence only.
- Don't rely on `data-testid` alone — X strips these in some experiments.
  Always pair CSS with aria/text.
- Don't commit the `AUDIT_SPACE_URL` — that goes in `.env`, not the audit
  script.
