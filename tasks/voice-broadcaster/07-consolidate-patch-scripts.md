# Task: Consolidate Untracked Patch Scripts

## Context
The working tree at repo root contains many untracked utility scripts
that were used during iterative development on the VM:

```
kick-loop.js                 # periodically kicks an agent
open-agent2.js               # opens agent-2 page in remote chrome
patch-agent2-respond.py      # python sed-ish patcher
patch-greet.py
patch-realtime.py
patch-transcript-events.py
patch-turn-gating.py
patch-two-agent-loop.py
reconnect-agent.js
unmute-and-greet.js
unmute-only.js
update-prompts.js
vm-automation.js
x-join-only.js
```

Their state is brittle — re-running a `patch-*.py` after the source has
already been edited might no-op or might corrupt. They live outside git
so they're invisible to CI and to PR review.

## Goal
Audit each script, decide its intent, and either:
1. Fold its behavior into proper source (server.js, agent client,
   x-spaces module, or a new `scripts/` entry checked in), OR
2. Confirm it's a one-time bootstrap that has already been applied and
   delete it.

End state: the working tree shows **no untracked operational scripts** at
the root. Anything still useful lives in `scripts/` and is checked in.

## Why now
Auth + dashboard work just landed. The untracked scripts are stale —
some of them patched files that now look different. Leaving them
encourages future operators to run them and corrupt state. Also: the
production VM is presumably running code that's *not* identical to git,
which makes debugging impossible.

## Approach

For each script, perform this audit and record findings in a temporary
working doc (`tasks/voice-broadcaster/07-audit-notes.md`):

| Script | Type | Target file(s) | What it does | Current source state | Action |
|---|---|---|---|---|---|
| `patch-greet.py` | patcher | server.js? agent HTML? | … | already applied / partial / not applied | merge / delete |

For each `patch-*.py`:
1. Read the script — most are `with open(...) as f: f.read().replace(...)`
   patterns. Find the strings being inserted/replaced.
2. `git log -p -S '<unique string from the patch>'` to see if the target
   already contains the change.
3. If applied → delete the patcher.
4. If partial / not applied → port the change as a real edit to the
   target source file, then delete the patcher.

For each `*.js` helper:
1. Read; understand the role.
2. If still useful (e.g. `vm-automation.js`, `reconnect-agent.js`):
   move to `scripts/<name>.js`, harden (argparse via `commander` or
   manual), add a one-line description at the top, register in
   `package.json` as `"scripts": { "<name>": "node scripts/<name>.js" }`.
3. If one-time bootstrap (e.g. `x-join-only.js`): keep behind a
   commented-out `scripts` entry but check the file in under
   `scripts/legacy/`, OR delete after confirming it never needs to run
   again.

## Concrete plan per script

(Best-guess starting taxonomy — verify before acting.)

| Script | Likely action |
|---|---|
| `kick-loop.js` | Move to `scripts/kick-loop.js`; document via `--help` |
| `open-agent2.js` | Move to `scripts/open-agent.js` with `--agent 0|1` flag |
| `patch-*.py` (all) | Check if already applied; merge or delete |
| `reconnect-agent.js` | Fold into `public/js/provider-openai-realtime.js` reconnect logic (see task `11-realtime-reconnect.md`); if that task is already done, delete |
| `unmute-and-greet.js`, `unmute-only.js` | These hit `pactl` + send greeting; fold into the `/pulse/unmute` endpoint from `04-silence-and-route-health.md` |
| `update-prompts.js` | Already obsoleted by `personalityActivate` socket event from `06-personality-hot-swap.md`; delete or convert to a CLI wrapper |
| `vm-automation.js` | Almost certainly the VM bring-up flow. Move to `scripts/vm-bringup.js` and document in `12-vm-runbook.md` |
| `x-join-only.js` | Likely a manual Space-join probe. Keep in `scripts/probes/` only if it's been used in the last month — else delete |

## Files to create / modify
- `scripts/` directory — populated with the survivors
- `package.json` — `"scripts"` entries pointing at each survivor
- `server.js` / `public/js/*.js` / `x-spaces/*` — accept merged
  behaviors
- `tasks/voice-broadcaster/07-audit-notes.md` — write-up of decisions
  per script (delete this file when the PR merges; but ship it for
  review)
- Delete the originals at the repo root

## How to verify
1. `git status` shows zero untracked `*.py` files at the root, and zero
   ad-hoc `*.js` helpers at the root (besides `server.js`).
2. Every surviving script is invokable via `pnpm <name>` and prints a
   sensible `--help`.
3. Re-running the broadcast on the VM works end-to-end without invoking
   any of the deleted scripts.

## Out of scope
- Migrating any of this into `packages/server`. That's a bigger task —
  see the SDK track `tasks/06-admin-dashboard-v2.md` and friends. Keep
  things at the repo root.
- Rewriting the scripts in TypeScript. Plain JS is fine.

## Gotchas
- **Do not** run any of the patch-*.py scripts as part of this audit.
  Reading them is enough. Running an already-applied patcher can corrupt
  source.
- Some of these scripts likely connect to remote Chrome (CDP on the VM,
  port 9222 or 9223). Don't try to actually invoke them from this
  Codespace — there's no Chrome instance to attach to.
- If a script's diff target no longer exists in source (e.g. it's
  patching a line that's been refactored away), the script is stale.
  Don't try to re-apply; check the relevant feature is already present
  via grep.
- Audit notes should reference exact line numbers in the script and in
  the target file. Future reviewers will want to verify your
  applied/not-applied determination.
