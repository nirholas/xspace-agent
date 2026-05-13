# Task: Transcript Filter + Export

## Context
The dashboard transcript pane shows every message in arrival order:
agent-0 lines, agent-1 lines, humans in the Space, dashboard-injected
operator messages, and now `audit:` system entries. It's already noisy
during a busy 30-minute Space, and after the show the only way to do a
postmortem is screen-recording the page.

## Goal
Add a filter row above the transcript with toggleable chips
(`agents`, `humans`, `audit`, `injected`), a search box, and an
**export** button that downloads either plaintext or JSON of the
visible (filtered) entries.

## Why now
Audit logging just shipped — the noise floor went up, so visibility into
"what's actually happening right now" got worse. Filters fix that. The
export turns the transcript into a paper trail that survives a tab refresh.

## Requirements

### UI (dashboard)
Above the transcript pane, add a filter bar:
```
🔍 [search…             ]  [agents ✓] [humans ✓] [audit ✓] [injected ✓]  [↓ export ▾]
```

Chip toggles instantly filter the visible entries. Search is a
case-insensitive substring match against the entry text (and the speaker
name). Both are applied as the user types — no submit.

Export menu options:
- **Copy as text** (clipboard) — newline-separated `[HH:MM:SS] NAME: text`.
- **Download .txt** — same format.
- **Download .json** — array of objects with `{ id, agentId, name, text, timestamp, isUser, isAudit }`.

Export honors the current filter — exporting "audit only" gives just the
audit log.

### State management
Keep the existing `state.seenMessageIds` and DOM in arrival order. Don't
remove non-matching entries — just hide them with `display: none`. This
preserves stable scroll position and avoids re-rendering 1000+ rows when
toggling chips.

Persist filter state in `sessionStorage` (`xspace.filters`) so a tab
reload keeps the same view.

### Implementation notes
- Add a `dataset.kind` attribute to each entry on creation
  (`agent` / `human` / `audit` / `injected`). `injected` = entries whose
  `id` was created via the operator's `userMessage` emit; tag at the
  call site in `sendInject()` before the round-trip echo lands.
- Search match: collapse whitespace, lowercase both sides, indexOf.
- Apply filters on every new entry too (so live-arriving messages
  respect the current filter).
- Keep auto-scroll behavior: only scroll to bottom if the user was
  already near the bottom *and* the new entry is visible under the
  current filter.

### Audit
- "export" is read-only; no audit entry needed. But add
  `auditEntry("export transcript (NN entries) by <op>")` on click of
  the JSON download — it's the only one that produces a portable
  artifact, useful to log.

## Files to modify
- `public/dashboard.html` — filter bar markup
- `public/dashboard.css` — chip + search styles
- `public/dashboard.js` — filter state, applyFilters(), export handlers

## How to verify
1. With a live conversation running, type "fuck" in search — only
   entries containing "fuck" remain visible. Auto-scroll still works
   for new matching lines.
2. Toggle off `audit` — system entries vanish; agents and humans remain.
3. Toggle off everything: empty pane. Toggle back: full pane.
4. Reload the tab — filter state restored from `sessionStorage`.
5. Click "Download .json" with `humans` only — file contains only the
   human-attributed entries.
6. Big show: 500 entries, type a search — filtering is instant (<50 ms
   on a mid-range laptop). If it stutters, batch with `requestAnimationFrame`.

## Out of scope
- Time-range filter (last 5 minutes, etc.). Useful but not now.
- Server-side persistence of the transcript beyond the in-memory 100/200
  message buffer. Out of scope for this task.
- Highlighting matches inside entries. Optional polish — defer.

## Gotchas
- Don't store the search string in URL hash — operators screenshare the
  dashboard and a "fuck" search would be embarrassing in the URL bar.
- The transcript pane already truncates at 100 entries server-side in
  `spaceState.messages`. Don't try to "load older" from the server —
  not stored. Document this in a tooltip on the export button.
- The "injected" category is a client-side concept: tag the entry as
  injected when `sendInject()` fires, before the server echoes it back.
  Match the echo by `id` (the entry already has the messageId from the
  socket).
- Keep the filter bar accessible: chips should be `<button>` with
  `aria-pressed`, search should be `<input type="search">`.
