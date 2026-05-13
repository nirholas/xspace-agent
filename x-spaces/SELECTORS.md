# X Spaces Selector Inventory

**Last verified:** 2026-05-13  
**Source of truth:** [`packages/core/src/browser/selectors.ts`](../packages/core/src/browser/selectors.ts)  
**Engine:** [`packages/core/src/browser/selector-engine.ts`](../packages/core/src/browser/selector-engine.ts)

Audit with: `pnpm selectors:audit` (requires `AUDIT_SPACE_URL` env var and Chrome on CDP port 9222).

---

## Login flow

| Action | Primary selector | Fallback 1 | Fallback 2 | Fallback 3 | Text match | Aria match |
|--------|-----------------|------------|------------|------------|------------|------------|
| `username-input` | `input[autocomplete="username"]` | `input[name="text"]` | `input[type="text"]` | — | — | — |
| `next-button` | `[data-testid="LoginForm_Forward_Button"]` | `button[aria-label="Next"]` | `[role="button"][data-testid*="Forward"]` | `[role="button"] span` | Next | Next |
| `password-input` | `input[name="password"]` | `input[type="password"]` | — | — | — | — |
| `login-button` | `[data-testid="LoginForm_Login_Button"]` | `button[aria-label="Log in"]` | `[role="button"][data-testid*="Login"]` | `button[type="submit"]` | Log in | Log in |
| `verify-email-input` | `input[data-testid="ocfEnterTextTextInput"]` | `input[placeholder*="email" i]` | `input[placeholder*="phone" i]` | `input[type="text"]:not([autocomplete="username"])` | — | — |
| `verify-next-button` | `[data-testid="ocfEnterTextNextButton"]` | `[role="button"][data-testid*="Next"]` | `button[aria-label="Next"]` | — | Next | — |

---

## Home feed (login confirmation)

| Action | Primary selector | Fallback 1 | Fallback 2 | Text match | Aria match |
|--------|-----------------|------------|------------|------------|------------|
| `home-timeline` | `[data-testid="primaryColumn"]` | `main[role="main"]` | `nav[aria-label*="Home" i]` | — | — |

---

## Space UI

| Action | Primary selector | Fallback 1 | Fallback 2 | Fallback 3+ | Text match | Aria match | Destructive |
|--------|-----------------|------------|------------|-------------|------------|------------|-------------|
| `join-button` | `button[aria-label="Start listening"]` | `[data-testid="SpaceJoinButton"]` | `button[aria-label*="listen" i]` | `…join…`, `…tune in…` | Start listening | Start listening | No |
| `request-speaker` | `button[aria-label="Request to speak"]` | `button[aria-label*="Request"]` | `[data-testid="SpaceRequestToSpeakButton"]` | 11 more (see source) | Request to speak | Request to speak | No |
| `unmute` | `[data-testid="SpaceMuteButton"]` | `[data-testid="SpaceUnmuteButton"]` | `button[aria-label="Unmute"]` | 12 more (see source) | Unmute | Unmute | No |
| `mute` | `[data-testid="SpaceMuteButton"]` | `button[aria-label="Mute"]` | `button[aria-label*="Mute"]` | `…Turn off microphone…`, `…mic is on…`, div role | Mute | Mute | **Yes** |
| `leave-button` | `[data-testid="SpaceLeaveButton"]` | `button[aria-label*="leave" i]` | `[data-testid="SpaceDockExpanded"] button` | — | Leave | leave | **Yes** |
| `space-dock` | `[data-testid="SpaceDockExpanded"]` | `[data-testid="SpaceDockCollapsed"]` | — | — | — | — | No |
| `mic-button` | `[data-testid="SpaceMuteButton"]` | `[data-testid="SpaceUnmuteButton"]` | `button[aria-label*="microphone"]` | 9 more (see source) | — | microphone | No |
| `speaker-list` | `[data-testid="SpaceSpeakerAvatar"]` | `[data-testid="SpaceSpeakerCard"]` | `[aria-label*="speaker" i]` | `img[src*="profile_images"]` | — | — | No |

---

## Space state detection

| Action | Primary selector | Fallback 1 | Fallback 2 | Text match | Aria match |
|--------|-----------------|------------|------------|------------|------------|
| `space-ended` | `[data-testid="spaceEnded"]` | `[data-testid="SpaceEndedBanner"]` | `[aria-label*="ended" i]` | has ended | — |
| `space-live-indicator` | `[data-testid="SpaceLiveIndicator"]` | `[data-testid="SpaceLiveBadge"]` | `[aria-label*="LIVE" i]` | LIVE | — |

---

## Notes

- **`data-testid` selectors** may be stripped in some X experiments. Always paired with aria/text fallbacks.
- **`SelectorEngine`** tries strategies in priority order (lowest number first), then `textMatch`, then `ariaMatch`, then full accessibility-tree search.
- **`selectorFallback` event** fires on `XSpaceAgent` whenever a non-primary strategy wins — use it to detect primary breakage in the wild before a Space session.
- **Destructive actions** (mute, leave) are audited by DOM presence only in `audit-selectors.js` — never clicked during audit.
- **Legacy `x-spaces/selectors.js`** is deprecated; update `packages/core/src/browser/selectors.ts` for all new selectors.

---

## Running the audit

```bash
# Prerequisite: Chrome with --remote-debugging-port=9222 and logged into X
export AUDIT_SPACE_URL=https://x.com/i/spaces/<space_id>
pnpm selectors:audit

# Override CDP port if needed
CDP_PORT=9223 AUDIT_SPACE_URL=https://x.com/i/spaces/<id> pnpm selectors:audit
```

Exit codes:
- `0` — all selectors have at least one working strategy
- `1` — one or more selectors are BROKEN (zero strategies found)
- `2` — could not connect to Chrome or navigation failed
