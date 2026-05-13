# Script Audit Notes — Task 07

Audited 2026-05-13. All scripts were committed at repo root; this doc records the
per-script decision and how it was executed.

---

## Audit Table

| Script | Type | Target path(s) | What it does | Source state | Action taken |
|---|---|---|---|---|---|
| `patch-claim-token.py` | patcher | `server.js` l.904; `public/js/provider-openai-realtime.js` | Claim-token: server emits `cancelResponse` to other agents when one starts speaking; agent pages fire `response.cancel` | NOT applied — `statusChange` handler (server.js:904) lacks claim-token branch; `provider-openai-realtime.js` has no `cancelResponse` listener | **Merged** into both files; patcher deleted |
| `patch-greet.py` | patcher | `/home/agent/ai-agents-x-space/public/agent1.html` | Auto-greet on data-channel open | Targets a different VM codebase path; current `server-agent1.html` has no inline JS (loads `provider-openai-realtime.js` externally); feature superseded by dashboard kick | **Deleted** — stale target |
| `patch-realtime.py` | patcher | `/home/agent/ai-agents-x-space/index.js`, `agent1.html`, `agent2.html` | GA Realtime API: model name, URL, body shape, ephemeral key path | Targets different VM path; model name (`gpt-realtime`) already in `providers/openai-realtime.js` independently | **Deleted** — stale target |
| `kick-loop.js` | helper | Agent Chrome CDP 9222 | Fires `response.create` on agent1 to kick off banter | Already deleted from working tree; superseded by dashboard `kickAgent` button | Staged deletion |
| `open-agent2.js` | helper | Agent Chrome CDP 9222 | Opens agent2 tab and clicks Connect | Already deleted; functionality rolled into `vm-automation.js` flow | Staged deletion |
| `patch-agent2-respond.py` | patcher | (deleted) | — | Already deleted | Staged deletion |
| `patch-transcript-events.py` | patcher | (deleted) | — | Already deleted | Staged deletion |
| `patch-turn-gating.py` | patcher | (deleted) | — | Already deleted | Staged deletion |
| `patch-two-agent-loop.py` | patcher | (deleted) | — | Already deleted | Staged deletion |
| `reconnect-agent.js` | helper | Agent Chrome CDP 9222 | Reloads `/agent1` tab and clicks Connect; useful for recovering a dropped Realtime session | Still useful | **Moved** → `scripts/reconnect-agent.js` |
| `unmute-and-greet.js` | helper | X Chrome CDP 9223 + Agent Chrome 9222 | Polls for unmute button (90 s), clicks it, then fires greeting `response.create` | Still the canonical operator action after phone-accept | **Moved** → `scripts/unmute-and-greet.js` |
| `unmute-only.js` | helper | X Chrome CDP 9223 | Same as above but no greeting | Still useful (greet already fired / different flow) | **Moved** → `scripts/unmute-only.js` |
| `unmute-dual.js` | helper | X Chrome CDP 9222 + 9223 (dual) | Unmutes both X Chromes (dual-agent setup) | Already deleted; dual setup superseded by single-instance dashboard | Staged deletion |
| `update-prompts.js` | helper | Agent Chrome CDP 9222 | Live-updates both agents via `session.update`; contains hardcoded three.ws persona prompts | Already deleted; superseded by dashboard `updatePrompt` / personality hot-swap | Staged deletion |
| `vm-automation.js` | helper | Agent Chrome 9222 + X Chrome 9223 | Full VM bringup: set X cookies, load agent page, navigate X tab, click Start listening + Request to speak | Core operational script; still needed | **Moved** → `scripts/vm-bringup.js` |
| `vm-automation-dual.js` | helper | (deleted) | Dual-agent variant | Already deleted | Staged deletion |
| `vm-launch-dual.sh` | shell | (deleted) | Dual-agent shell launcher | Already deleted | Staged deletion |
| `x-join-only.js` | helper | X Chrome CDP 9223 | X tab only: set cookies, navigate to Space, Start listening, Request to speak | Useful probe when agent is already running | **Moved** → `scripts/x-join-only.js` |

---

## patch-claim-token.py — merge detail

### server.js `statusChange` handler (line 904)

Original (lines 904–910):
```js
socket.on("statusChange", ({ agentId, status }) => {
  if (spaceState.agents[agentId]) {
    spaceState.agents[agentId].status = status
    spaceNS.emit("agentStatus", { agentId, status, name: spaceState.agents[agentId].name })
    broadcastSpaceState()
  }
})
```

Added claim-token branch: when `status === "speaking"`, emit `cancelResponse` to
every OTHER connected agent via its stored `socketId`. The `socketId` field is
already tracked at `agentConnect` (server.js:767–771).

### public/js/provider-openai-realtime.js

Added `cancelResponse` socket listener alongside `kickAgent`/`updatePrompt`/`textToAgent`
handlers. When received, fires `response.cancel` on the open data channel (the same
mechanism already used for barge-in at line 474).

---

## Verification checklist

- [ ] `git status` shows zero `*.py` and zero ad-hoc `*.js` at repo root (besides `server.js`)
- [ ] `pnpm vm-bringup <url>`, `pnpm reconnect-agent`, `pnpm unmute <url>`, `pnpm unmute-greet <url>`, `pnpm x-join <url>` all print `--help` or usage
- [ ] End-to-end broadcast on VM works without invoking any deleted script

_(Delete this file when the PR merges.)_
