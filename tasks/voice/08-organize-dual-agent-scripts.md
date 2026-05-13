# Voice Task 08 — Organize the dual-agent VM scripts

## Context

`git status` shows a pile of untracked files at the repo root from the
in-progress dual-agent X Spaces work:

```
kick-loop.js
open-agent2.js
patch-agent2-respond.py
patch-transcript-events.py
patch-turn-gating.py
patch-two-agent-loop.py
unmute-dual.js
update-prompts.js
vm-automation-dual.js
vm-launch-dual.sh
```

These are essential to running the live two-agent setup in the Codespace VM,
but as untracked top-level files they're:

- Easy to lose to `git clean -f`.
- Invisible to anyone else cloning the repo.
- Undocumented — nobody knows the right launch order.

This task gives them a permanent home, a README explaining how they fit
together, and gets them under version control without touching their
contents.

## Requirements

### 1. New directory structure

```
x-spaces/dual/
├── README.md                       # Launch sequence + flag reference
├── launch.sh                       # was: vm-launch-dual.sh
├── automation.js                   # was: vm-automation-dual.js
├── unmute.js                       # was: unmute-dual.js
├── kick-loop.js                    # moved as-is
├── open-agent2.js                  # moved as-is
├── update-prompts.js               # moved as-is
└── patches/
    ├── README.md                   # One-line description per .py
    ├── agent2-respond.py
    ├── transcript-events.py
    ├── turn-gating.py
    └── two-agent-loop.py
```

Rename the four patches to drop the `patch-` prefix (the directory already
says `patches/`).

### 2. Don't edit the scripts' contents

Move the files via `git mv` so history is preserved if any were tracked,
or `mv` + `git add` for untracked ones. **Do not modify any code** in these
files in this task — that's separate work. Even path references inside the
scripts (`./public/...`) should keep working when run from the repo root via
the new launcher, not from inside `x-spaces/dual/`.

If a script has a hardcoded relative path that breaks after moving, fix it
**only by adding a CWD comment at the top**, e.g.:

```js
// Run from repo root: node x-spaces/dual/automation.js
```

Or update the launcher to `cd` to the repo root first.

### 3. README content

`x-spaces/dual/README.md` must include:

- **What this does**: one paragraph. Two voice agents, OpenAI Realtime,
  PulseAudio cables, running inside a Codespace VM.
- **Prerequisites**: PulseAudio installed, ALSA cables created, Chromium
  installed, `.env` populated.
- **The launch sequence** as a numbered list — derive it from reading
  `vm-launch-dual.sh` and `vm-automation-dual.js`. Don't guess.
- **What each script does** — one line each.
- **Common failure modes** — e.g. "agent stuck on listening" → check
  `pactl list short sink-inputs`.
- **How to clean up** — kill processes, free PulseAudio sinks.

`x-spaces/dual/patches/README.md` lists each `.py` file and one line about
what it patches (read the diff at the top of each file).

### 4. Update root references

Search the repo for references to the old filenames and update them:

```bash
git grep -nE "vm-launch-dual|vm-automation-dual|unmute-dual|patch-agent2-respond|patch-transcript-events|patch-turn-gating|patch-two-agent-loop|open-agent2\.js|kick-loop\.js|update-prompts\.js"
```

Likely hits: none in the SDK (these are operator-side scripts), but check
`README.md`, `docs/`, and any other markdown.

### 5. `.gitignore` cleanup

If `.gitignore` doesn't ignore `debug-screenshots/` and `*.png` at the repo
root, add them — those are noise.

### 6. Don't include build artifacts

The move should not pull in `node_modules`, screenshots, or local logs.
Verify the diff is small.

## Files to Create

- `x-spaces/dual/README.md`
- `x-spaces/dual/patches/README.md`

## Files to Move

- All ten files listed in Context, into the layout above.

## Files to Modify

- `.gitignore` — only if missing entries for screenshots / logs.
- Any markdown references to the old paths.

## Files NOT to Touch

- The contents of the moved scripts.
- `server.js`, `public/**`, `packages/**`.
- `providers/**`.

## Acceptance Criteria

- [ ] `git status` no longer shows the listed loose files as untracked.
- [ ] Running the new launcher (`bash x-spaces/dual/launch.sh` or whatever the
      moved script becomes) reproduces the working dual-agent launch.
- [ ] `x-spaces/dual/README.md` lets a new operator launch the system without
      asking questions.
- [ ] `git log --follow` on each moved file still shows the original commit
      (if the file was previously tracked).

## Don'ts

- Don't refactor the JavaScript or Python scripts in this task. We're
  organizing, not rewriting.
- Don't merge the patches into the main `server.js` — they exist for a reason
  (live-modify behavior without restart).
- Don't add a new package.json inside `x-spaces/dual/`. It's not a separate
  workspace; it shares the root.
