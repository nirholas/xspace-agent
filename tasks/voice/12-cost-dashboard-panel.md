# Voice Task 12 — Cost + voice-state panel in `/dashboard`

## Context

`public/dashboard.html` and `public/dashboard.css` are new in this branch.
They give the operator visibility into the live Space. What's missing is a
**cost panel** showing:

- ElevenLabs chars used today vs. daily cap.
- OpenAI Realtime sessions minted today.
- Current voices per agent + recent voice-change audit log.
- Recent rate-limit / upstream-error counts.

The data is already exposed by `/metrics` (Voice Task 06). This task wires
a panel against it.

**Run after Voice Task 06.**

## Requirements

### 1. Panel design

A single card in the dashboard layout titled **"Cost & voices"**. Inside:

- **Two horizontal progress bars**, one per agent? No — one bar per resource:
  - "ElevenLabs today: 18.4k / 200k chars" with a fill bar.
  - "OpenAI Realtime: 12 sessions today" (no cap to show, just a count).
- **Voice rows** (one per agent): name, current voice ID, short voice name,
  preview button (plays a short sample via `/tts/:id/stream` with a known
  string — see Voice Task 13).
- **Recent voice changes**: last 5 entries from the audit log (lines like
  `voice change agent 0: A → B`). Scrollable if longer.
- **Counters strip**: "Rate-limited: 3 · Upstream errors: 0 · 80% warning: yes".

Use the existing `public/dashboard.css` palette. Match the typography and
spacing of the other dashboard cards. Don't re-invent.

### 2. Data fetching

Poll `GET /metrics?key=${AGENT_AUTH_KEY}` every 10 seconds when the panel
is visible. Use `requestAnimationFrame`-throttled DOM updates so a long
session doesn't accumulate render churn.

Live audit-log updates come via the existing `auditLog` Socket.IO event —
subscribe and prepend new entries to the list.

The `costWarning` event (also from Voice Task 06) should flash the panel
title yellow at 80% and red at 95%. Add a tiny inline SVG/CSS animation;
don't pull in a toast library.

### 3. Voice picker on the dashboard

The dashboard should also have its own voice-change UI (separate from the
agent pages' picker). Behavior identical: `GET /voices`, populate two
selects (one per agent), emit `setVoice` on change. This lets an operator
adjust voices from a single screen without opening both agent tabs.

### 4. Preview button

If Voice Task 13 has shipped, the panel uses the same preview mechanism.
If not, stub: clicking the preview button does nothing yet but is rendered
disabled with tooltip "Preview pending — see Voice Task 13".

### 5. Empty / error states

- No EL key configured: panel shows "ElevenLabs not configured" with a
  link to the relevant `.env.example` line.
- `/metrics` returning 401: redirect to the existing login modal.
- Missing data fields: render `—` instead of `undefined`.

## Files to Create

- `public/js/dashboard-cost-panel.js` — IIFE, ~150 lines, self-contained.

## Files to Modify

- `public/dashboard.html` — add the panel markup inside the existing card
  grid.
- `public/dashboard.css` — add panel-specific styles (progress bars,
  voice-row, audit-list). Reuse existing tokens (colors, spacing).
- `public/js/dashboard.js` (if it exists) — register the panel module on
  page load.

## Files NOT to Touch

- `server.js` — `/metrics` and `costWarning` are owned by Voice Task 06.
- `provider-openai-realtime.js`
- `packages/**`

## Acceptance Criteria

- [ ] Loading `/dashboard?key=<correct>` shows the panel with live data.
- [ ] Changing a voice from the dashboard picker is reflected on both agent
      pages within ~200 ms (via the `voiceUpdated` broadcast).
- [ ] When `ELEVENLABS_DAILY_CHAR_CAP` is set very low and the cap is hit, the
      panel title goes yellow then red, and "ElevenLabs today" shows
      `200k / 200k` with the bar maxed.
- [ ] Refreshing the dashboard does not double-subscribe to socket events
      (no listener leaks — verify in DevTools event listeners panel).
- [ ] If `ELEVENLABS_API_KEY` is unset, the panel renders the empty state
      cleanly; nothing crashes.
- [ ] Lighthouse "Best practices" score for the dashboard page doesn't drop
      vs. before this change.

## Don'ts

- Don't add Chart.js / Recharts. CSS-only progress bars are enough.
- Don't show the raw `ADMIN_API_KEY` anywhere (it's injected as
  `window.AGENT_AUTH_KEY` — fine to read, never to render).
- Don't poll `/metrics` faster than every 5 seconds. Cost should not be
  measured continuously.
- Don't duplicate the audit log on every poll — diff and append.
