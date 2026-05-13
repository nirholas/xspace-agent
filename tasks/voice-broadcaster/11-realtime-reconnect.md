# Task: Auto-Reconnect for Realtime WebRTC

## Context
The two agent pages (`/alice`, `/bob`) establish an OpenAI Realtime
session via WebRTC: ephemeral key from `/session/:id`, then SDP offer
to `api.openai.com/v1/realtime`. Once connected, they stay connected
*until something glitches*: a transient ICE failure, the OpenAI session
TTL hitting (these sessions expire), the laptop sleeping, the VM
restarting the Chrome instance, an `oniceconnectionstatechange` going
to `failed` or `disconnected`.

When that happens, the current code marks the agent disconnected and
**stops**. An operator must reload the agent tab manually. During a
live show, that's a 30–60 s hole in the broadcast.

## Goal
Make the agent client auto-reconnect with exponential backoff, restore
the personality prompt and voice, and never sit silently disconnected
for more than 10 seconds without trying again.

## Why now
This is by far the most common operator pain. Every long show hits at
least one drop. Fixing it removes a class of pages.

## Requirements

### Detection
In `public/js/provider-openai-realtime.js`, the `pc.oniceconnectionstatechange`
handler already routes `failed`/`disconnected`/`closed` to
`agent.markDisconnected()`. Hook there: schedule a reconnect.

Also detect:
- `dc.onclose` — data channel closed unexpectedly.
- `dc.onerror`.
- Health pings: every 15 s, send `{ type: "session.update", session: {} }`
  through the data channel and timeout if no ack within 5 s. Trigger
  reconnect on timeout.

### Reconnect strategy
- Wait 1 s, then 2 s, 4 s, 8 s, 15 s, 30 s, capped at 30 s.
- Tear down the old `pc` and `dc` cleanly: `pc.close()`, null the refs,
  stop any local mic tracks (`getUserMedia` stream).
- Re-run `startConnection()` from scratch — that already mints a fresh
  ephemeral key and a new SDP exchange.
- On success: reset the backoff counter; re-apply the current
  personality prompt via `session.update` (so prompt updates pushed by
  the dashboard while disconnected are honored on reconnect); rejoin
  the turn-taking by emitting `agentConnect`.

### UI feedback
- `agent.connectBtn.textContent = "Reconnecting (attempt N)..."` while
  retrying.
- `agent.log("ICE failed, reconnecting in 2s", "warn")` on each retry.
- Connection status indicator turns yellow during reconnect (not red).
- The dashboard already shows `offline` when `agentDisconnect` fires;
  add a `"reconnecting"` status that the agent emits during retry.
  Dashboard renders it as a pulsing yellow badge.

### Server-side
- New status `"reconnecting"` accepted by the existing `statusChange`
  handler. Audit log entry per reconnect: `audit: agent 0
  reconnecting (attempt N)`.
- Track `lastReconnectAt` per agent in `spaceState.agents`. Surface in
  the dashboard tooltip.

### Failure ceilings
- After 5 consecutive failed reconnects, stop retrying and require a
  manual click. Emit `agentDeadlock { agentId, reason }` so the
  dashboard can show a big "kick to retry" button. This avoids
  pathological auto-reconnect loops that burn ephemeral keys.

## Files to modify
- `public/js/provider-openai-realtime.js` — main work
- `public/js/agent-common.js` — `markReconnecting()` helper; integrate
  with `setStatus`
- `server.js` — accept `"reconnecting"` status, audit lines,
  `lastReconnectAt` tracking
- `public/dashboard.js` + `.css` — render the new status, deadlock
  button

## How to verify
1. Boot, connect both agents, conversation running.
2. From devtools console on the Alice tab:
   ```js
   pc.getSenders().forEach(s => s.track.stop())
   // or:
   pc.close()
   ```
   Within 2 s, Alice shows "Reconnecting (attempt 1)" and the dashboard
   shows yellow "reconnecting" badge. Within ~3–8 s Alice is back live.
   The audit log shows two rows (one fail, one back-up).
3. Disable network (browser devtools → Network → Offline). After 5
   attempts, Alice shows "deadlocked — click to retry" in the agent
   page; dashboard shows a "kick to retry" button. Re-enable network,
   click — recovers.
4. Push a prompt update from the dashboard. Force-disconnect Alice.
   Wait for reconnect. Confirm Alice's next response uses the *new*
   prompt — the reconnect preserves the live prompt, not the original
   personality file.
5. Long-soak: leave the Codespace running for 1 hour with a live
   conversation. Manually disrupt connection 10 times. Zero manual
   reloads required.

## Out of scope
- Server-side reconnect logic for the X Spaces Puppeteer bot (different
  failure surface — see `12-vm-runbook.md` for that).
- Migrating off WebRTC. Realtime API supports a WebSocket transport now;
  that's a future swap, not a reconnect concern.
- Recovery of in-flight audio (if the agent was speaking when the drop
  happened, the listener heard truncation — that's audible regardless).

## Gotchas
- The ephemeral key from `/session/:id` is one-shot. Each reconnect
  attempt must fetch a fresh one. Don't cache the key.
- OpenAI's WebRTC endpoint occasionally returns SDP errors that look
  like network failures but are actually quota / model availability.
  Surface the response status from `sdpRes` in the agent log so the
  operator can distinguish "rate-limited" from "bad network".
- `pc.close()` is synchronous but cleanup is not — wait a tick before
  re-creating to avoid Chrome warnings.
- `getUserMedia` should be called **once** and the resulting stream
  re-used across reconnects. Stopping and re-requesting the mic on
  every retry will pop a permission prompt under some Chrome versions.
- Make the health-ping cheap: a `session.update` with an empty session
  is a no-op server-side. Don't ping with `response.create` — that
  would generate audio every 15 s.
