# Task: Personality Hot-Swap

## Context
Agent personalities are currently hardcoded in `server.js` as `baseInfo`
+ `spacePrompts[0]` / `spacePrompts[1]` (see lines ~252–296). To change
how Bob talks, you edit `server.js` and restart the server. That's bad
because:
1. Restarting drops both Realtime sessions, both browser tabs need
   reconnection, and the show goes dark for 10+ seconds.
2. Personalities are show-specific (one show wants debate-mode, another
   wants comedy roast, another wants product Q&A). Hardcoded prompts
   conflate config with code.

The dashboard already supports per-agent prompt editing in a textarea
that pushes via `promptUpdate`, but the values are lost on next restart
because they're not persisted anywhere.

## Goal
Move personalities to a config file. Make the dashboard a picker that
chooses among named personalities per agent. Hot-reload on file change.
Persist the last-applied personality per agent.

## Why now
The hardcoded prompts ship the project's identity (CONTRACT, WEBSITE,
TEAM, etc.) baked in. That's a config concern, not a code concern.
Multiple operators want to run different personas without git churn.

## Requirements

### Config file
- Path: `personalities.json` at repo root. Gitignore the file; check in
  `personalities.example.json` so the template ships.
- Schema:
  ```json
  {
    "active":   { "0": "roastmaster", "1": "dry-wit" },
    "personalities": {
      "roastmaster": {
        "displayName": "Roastmaster",
        "voice": "verse",
        "tags": ["loud", "comedy"],
        "prompt": "You are a HUMAN, not an AI. ..."
      },
      "dry-wit": { ... },
      "explainer": { ... }
    }
  }
  ```
- Re-load on mtime change (debounced `fs.watch`). Validate with a small
  schema check; on failure, log the error and keep the previous good copy
  in memory.

### Server
- Replace the hardcoded `spacePrompts` / `spaceVoices` with a derived
  view of the active personalities:
  ```js
  function activePromptFor(agentId) {
    return personalities[active[agentId]]?.prompt
  }
  ```
- Existing `socket.on("promptUpdate", ...)` continues to work — but
  rename it so that "promptUpdate" means *ad hoc* (no save) and add a
  new `personalityActivate` event that writes through to `personalities.json`'s
  `active` field.
- New endpoints (gated):
  - `GET  /personalities` → full personalities map + active.
  - `POST /personalities/active` → `{ agentId, name }` validates the
    name exists, writes to disk, audits.
  - `POST /personalities` → upsert a personality (admin role only).
- Audit every change.

### Dashboard
- Each agent card gets a `<select>` above the prompt textarea, populated
  from `/personalities`. Changing it:
  1. Fires `personalityActivate` (persistent).
  2. Re-emits the activated prompt to the running agent so the new
     session prompt takes effect immediately (use the existing
     `updatePrompt` data-channel path).
  3. Updates the voice selector if the personality specifies one.
- Editing the textarea and clicking "save & push" becomes an *override*
  (transient): pushes via `promptUpdate`, but does not write to the file.
  Show a "(override active)" badge until the operator picks a fresh
  personality from the dropdown.
- Add a "save as new personality…" button next to the textarea that
  POSTs the current text to `/personalities` with a prompt for a name.

### Initialization
- On server boot:
  - If `personalities.json` exists, use it.
  - Else, copy `personalities.example.json` → `personalities.json` once
    (don't overwrite). Fall back to the current hardcoded prompts if
    neither exists, with a one-time warning.

## Files to modify / create
- `personalities.example.json` (new) — seeded from the current hardcoded
  prompts to preserve the existing voice.
- `.gitignore` (add `personalities.json`)
- `server.js`
- `public/dashboard.html` (selector markup, "save as" button)
- `public/dashboard.css`
- `public/dashboard.js`

## How to verify
1. First boot creates `personalities.json` from the example. Confirm
   transcripts unchanged — same personalities, same voices.
2. Edit `personalities.json` directly, change Bob's prompt, save. Within
   ~1 s the dashboard shows the updated text in the dropdown's selected
   option. The running Bob session does NOT change (file edits don't
   force a push; only operator action does).
3. In the dashboard, select a different personality for Bob from the
   dropdown. Bob's next response uses the new prompt. Audit row appears.
4. Edit the textarea for Alice and push — the dropdown shows "(override)"
   suffix on Alice. Pick a fresh personality, override clears.
5. Restart server. Dashboard reflects the last persisted `active`
   pair from `personalities.json`.

## Out of scope
- A WYSIWYG prompt editor or templating engine. Plain text only.
- Per-personality model selection (which OpenAI model). Out of scope —
  the env var continues to set that globally.
- A "schedule" feature (auto-rotate every 10 minutes). Future task.

## Gotchas
- The Realtime API `session.update` only updates *future* responses, not
  the in-flight one. Document this in the dashboard tooltip on the
  personality picker.
- File-watch debouncing: editors often write atomically (`mv` over the
  original), which fires both a `rename` and a `change` event. Use a
  100-ms debounce + retry-on-ENOENT (the file briefly disappears during
  atomic rename).
- The current hardcoded `baseInfo` block contains the project metadata
  (`PROJECT_NAME`, `CONTRACT`, etc.) via template literal. Keep that
  substitution logic — read the prompt template from
  `personalities.json` then interpolate env vars at activation time
  using a small `interpolate(template, env)` helper. Do not eval.
- `personalities.json` may contain operator notes — don't echo the full
  file in audit messages. Audit `"activated <name> for agent N"` only.
