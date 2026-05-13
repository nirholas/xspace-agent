# Task: Multi-Operator Authentication

## Context
Today the dashboard uses a single shared `ADMIN_API_KEY` for all operators.
Everyone who has the key is indistinguishable in the audit log (only their
IP is recorded). Revoking access for one collaborator means rotating the key
and re-distributing it to everyone.

## Goal
Replace (with backwards-compatibility) the single `ADMIN_API_KEY` with a
file-based operator registry. Each operator has a name, an API key, and a
role. The audit log records the operator's name, not just their IP. Adding
or revoking an operator does not require a server restart and does not
disturb other operators.

## Why now
The dashboard now ships an audit log of every `kick` / `promptUpdate` /
`userMessage`. The log is operationally useless without identity — "audit:
kick agent 0 (from 73.x.x.x)" doesn't tell you which collaborator did it.

## Requirements

### Operator registry
- File: `operators.json` at repo root (gitignored — add to `.gitignore`).
- Schema:
  ```json
  {
    "operators": [
      { "name": "nicholas",  "keyHash": "<scrypt-hash>", "role": "admin",    "createdAt": "...", "lastSeenAt": "..." },
      { "name": "viewer-bot","keyHash": "<scrypt-hash>", "role": "viewer",   "createdAt": "...", "lastSeenAt": "..." }
    ]
  }
  ```
- Hash algorithm: `crypto.scryptSync(key, salt, 64)` with a per-record salt
  (store as `salt:hash` in `keyHash`). Do not store plaintext keys on disk.
- Roles: `admin` (full access) and `viewer` (can subscribe to socket events
  and read `/state` / `/agent-config`, but `kickRequest` / `promptUpdate` /
  `userMessage` / `xspace:*` are rejected with `auditEntry('role rejected', socket)`).
- Atomic writes: write to `operators.json.tmp` then rename.

### CLI
- New script `scripts/operator.js` with sub-commands:
  - `add <name> [--role admin|viewer]` — prompts for key (or generates one
    with `crypto.randomBytes(32).toString('hex')` and prints it once)
  - `remove <name>`
  - `list` — shows names, roles, last-seen (no keys)
  - `rotate <name>` — generates a fresh key, prints it once
- Wire into `package.json` as `"operator": "node scripts/operator.js"` so
  it runs as `pnpm operator add nicholas`.

### Server changes (`server.js`)
- On startup, load `operators.json`. If absent, fall back to `ADMIN_API_KEY`
  behavior with a single synthetic operator `{ name: "default", role: "admin" }`.
- Replace `timingSafeEqual(key, ADMIN_API_KEY)` with a loader that finds
  the matching operator (constant-time compare across all entries — iterate
  all rows even on match to avoid timing leaks). Cache the parsed registry
  in memory; reload on SIGHUP and on file mtime change (watch with `fs.watch`).
- Annotate every authenticated request and socket with the operator name:
  - HTTP: `req.operator = { name, role }`
  - Socket: `socket.data.operator = { name, role }`
- Update `auditEntry()` to take an `operator` arg and include the name in
  the message: `audit: kick agent 0 by nicholas (from 73.x.x.x)`.
- Update `loginPageHtml` so the inline form accepts a `name` field too
  (optional — if omitted, server probes all operators).
- Update `/auth/check` to return `{ ok: true, name, role }` so the
  dashboard can show the current operator.

### Dashboard changes
- `public/dashboard.js`: after `/auth/check`, store `{ name, role }` and
  show "Logged in as <name>" in the top bar. Add a "log out" button next
  to it (clears `sessionStorage` and reloads).
- `public/dashboard.html`: add `<span id="who" class="muted"></span>` in
  the top bar.
- Hide write controls (kick buttons, prompt textarea save, inject input)
  if `role === "viewer"`.

### Agent pages
- `public/alice.html` / `public/bob.html` are operator-only (already gated).
  No changes needed except verifying that `window.AGENT_AUTH_KEY` injection
  still works with the new lookup (it should — the agent page is loaded by
  an admin with a key).

## Files to modify / create
- `server.js`
- `scripts/operator.js` (new)
- `package.json` (add the `operator` script)
- `.gitignore` (add `operators.json`)
- `public/dashboard.html`
- `public/dashboard.js`
- `.env.example` (note that `ADMIN_API_KEY` is fallback-only when no `operators.json` exists)
- `tasks/voice-broadcaster/00-index.md` (mark this task done in the table)

## How to verify
```bash
# 1. Generate two operators
pnpm operator add nicholas --role admin     # prints key K1
pnpm operator add collab    --role viewer   # prints key K2

# 2. Boot the server
node server.js

# 3. Verify
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $K1" http://127.0.0.1:3000/state
# → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer wrong" http://127.0.0.1:3000/state
# → 401
curl -s -X POST -H "Authorization: Bearer $K2" -H "Content-Type: application/json" \
  http://127.0.0.1:3000/kick/0
# → 403 (viewer role rejected)

# 4. Audit log via dashboard transcript should read:
#   "audit: kick agent 0 by nicholas (from 127.0.0.1)"

# 5. Rotate
pnpm operator rotate nicholas
# Old key now 401s; new key works. Other operators unaffected.
```

## Out of scope
- OAuth, SSO, magic links, password resets. This is a small-team operator
  registry, not user management.
- Per-route role policies beyond admin/viewer. Add a third role only when
  there's a concrete need.
- Web UI for managing operators. CLI only.

## Gotchas
- Always reload `operators.json` via a debounced `fs.watch` — naive watching
  fires multiple events per save and rewrites in flight will be observed
  half-written. Read the file with retries on JSON parse failure.
- Iterate the whole operator list during auth check to keep timing constant
  regardless of which (or whether) a key matches.
- The dashboard already stores the key in `sessionStorage` — don't add a
  parallel `localStorage` path. Tab-scoped is intentional.
