// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// X/Twitter Space UI selectors
// Self-healing definitions: each element has multiple strategies + fallbacks
// =============================================================================

import type { SelectorDefinition } from './selector-engine';

// ---------------------------------------------------------------------------
// Selector definitions with fallback chains
// ---------------------------------------------------------------------------

export const SELECTOR_DEFINITIONS: SelectorDefinition[] = [
  // ── Login flow ──────────────────────────────────────────────

  {
    name: 'username-input',
    description: 'Username input field on login page',
    strategies: [
      { name: 'autocomplete', selector: 'input[autocomplete="username"]', priority: 1 },
      { name: 'name', selector: 'input[name="text"]', priority: 2 },
      { name: 'type', selector: 'input[type="text"]', priority: 5 },
    ],
  },
  {
    name: 'next-button',
    description: 'Next button on login flow',
    strategies: [
      { name: 'testid', selector: '[data-testid="LoginForm_Forward_Button"]', priority: 1 },
      { name: 'role-text', selector: '[role="button"] span', priority: 5 },
    ],
    textMatch: 'Next',
    ariaMatch: 'Next',
  },
  {
    name: 'password-input',
    description: 'Password input field on login page',
    strategies: [
      { name: 'name', selector: 'input[name="password"]', priority: 1 },
      { name: 'type', selector: 'input[type="password"]', priority: 2 },
    ],
  },
  {
    name: 'login-button',
    description: 'Login/submit button on login page',
    strategies: [
      { name: 'testid', selector: '[data-testid="LoginForm_Login_Button"]', priority: 1 },
    ],
    textMatch: 'Log in',
    ariaMatch: 'Log in',
  },
  {
    name: 'verify-email-input',
    description: 'Email/phone verification input',
    strategies: [
      { name: 'testid', selector: 'input[data-testid="ocfEnterTextTextInput"]', priority: 1 },
    ],
  },
  {
    name: 'verify-next-button',
    description: 'Next button on verification step',
    strategies: [
      { name: 'testid', selector: '[data-testid="ocfEnterTextNextButton"]', priority: 1 },
    ],
    textMatch: 'Next',
  },

  // ── Home feed (confirms login success) ──────────────────────

  {
    name: 'home-timeline',
    description: 'Primary column on home page confirming login',
    strategies: [
      { name: 'testid', selector: '[data-testid="primaryColumn"]', priority: 1 },
    ],
  },

  // ── Space UI ────────────────────────────────────────────────

  {
    name: 'join-button',
    description: 'Button to join or listen to a Space',
    strategies: [
      { name: 'testid', selector: '[data-testid="SpaceJoinButton"]', priority: 1 },
      { name: 'aria-listen', selector: 'button[aria-label*="Listen"]', priority: 2 },
      { name: 'aria-join', selector: 'button[aria-label*="Join"]', priority: 3 },
    ],
    textMatch: 'Join',
    ariaMatch: 'Join',
  },
  {
    name: 'request-speaker',
    description: 'Button to request to speak in the Space',
    strategies: [
      { name: 'aria-request', selector: 'button[aria-label*="Request"]', priority: 1 },
      { name: 'aria-speak', selector: 'button[aria-label*="request to speak"]', priority: 2 },
    ],
    textMatch: 'Request to speak',
    ariaMatch: 'Request',
  },
  {
    name: 'unmute',
    description: 'Button to unmute microphone in Space',
    strategies: [
      { name: 'testid', selector: '[data-testid="SpaceMuteButton"]', priority: 1 },
      { name: 'aria-unmute', selector: 'button[aria-label*="Unmute"]', priority: 2 },
      { name: 'aria-unmute-lower', selector: 'button[aria-label*="unmute"]', priority: 3 },
    ],
    textMatch: 'Unmute',
    ariaMatch: 'Unmute',
  },
  {
    name: 'mute',
    description: 'Button to mute microphone in Space',
    strategies: [
      { name: 'testid', selector: '[data-testid="SpaceMuteButton"]', priority: 1 },
      { name: 'aria', selector: 'button[aria-label*="Mute"]', priority: 2 },
    ],
    textMatch: 'Mute',
    ariaMatch: 'Mute',
  },
  {
    name: 'leave-button',
    description: 'Button to leave the Space',
    strategies: [
      { name: 'testid', selector: '[data-testid="SpaceLeaveButton"]', priority: 1 },
      { name: 'aria', selector: 'button[aria-label*="Leave"]', priority: 2 },
    ],
    textMatch: 'Leave',
    ariaMatch: 'Leave',
  },
  {
    name: 'mic-button',
    description: 'Microphone button (mute or unmute)',
    strategies: [
      { name: 'aria-mic', selector: 'button[aria-label*="microphone"]', priority: 1 },
      { name: 'aria-mic-cap', selector: 'button[aria-label*="Microphone"]', priority: 2 },
      { name: 'aria-unmute-exact', selector: 'button[aria-label="Unmute"]', priority: 3 },
      { name: 'aria-mute-exact', selector: 'button[aria-label="Mute"]', priority: 4 },
    ],
    ariaMatch: 'microphone',
  },
  {
    name: 'speaker-list',
    description: 'Speaker avatars in the Space',
    strategies: [
      { name: 'testid', selector: '[data-testid="SpaceSpeakerAvatar"]', priority: 1 },
    ],
  },

  // ── Space state detection ───────────────────────────────────

  {
    name: 'space-ended',
    description: 'Indicator that the Space has ended',
    strategies: [
      { name: 'testid', selector: '[data-testid="spaceEnded"]', priority: 1 },
    ],
    textMatch: 'has ended',
  },
  {
    name: 'space-live-indicator',
    description: 'Indicator that the Space is currently live',
    strategies: [
      { name: 'testid', selector: '[data-testid="SpaceLiveIndicator"]', priority: 1 },
    ],
    textMatch: 'LIVE',
  },
];

// ---------------------------------------------------------------------------
// Legacy flat selector map (backward compatibility)
// ---------------------------------------------------------------------------

export const SELECTORS = {
  // Login flow
  LOGIN_USERNAME_INPUT: 'input[autocomplete="username"]',
  LOGIN_NEXT_BUTTON:
    'button:has-text("Next"), [role="button"] span:has-text("Next")',
  LOGIN_PASSWORD_INPUT: 'input[name="password"], input[type="password"]',
  LOGIN_SUBMIT_BUTTON: '[data-testid="LoginForm_Login_Button"]',
  VERIFY_EMAIL_INPUT: 'input[data-testid="ocfEnterTextTextInput"]',
  VERIFY_NEXT_BUTTON: '[data-testid="ocfEnterTextNextButton"]',

  // Home feed (confirms login success)
  HOME_TIMELINE: '[data-testid="primaryColumn"]',
  HOME_URL: 'https://x.com/home',

  // Space UI
  SPACE_JOIN_BUTTON:
    '[data-testid="SpaceJoinButton"], button[aria-label*="Listen"], button[aria-label*="Join"]',
  SPACE_REQUEST_SPEAK:
    'button[aria-label*="Request"], button[aria-label*="request to speak"]',
  SPACE_UNMUTE_BUTTON:
    '[data-testid="SpaceMuteButton"], button[aria-label*="Unmute"], button[aria-label*="unmute"]',
  SPACE_MUTE_BUTTON:
    '[data-testid="SpaceMuteButton"], button[aria-label*="Mute"]',
  SPACE_LEAVE_BUTTON:
    '[data-testid="SpaceLeaveButton"], button[aria-label*="Leave"]',
  SPACE_MIC_BUTTON:
    'button[aria-label*="microphone"], button[aria-label*="Microphone"], button[aria-label="Unmute"], button[aria-label="Mute"]',
  SPACE_SPEAKER_LIST: '[data-testid="SpaceSpeakerAvatar"]',

  // Space state detection
  SPACE_ENDED_TEXT:
    'span:has-text("This Space has ended"), span:has-text("Space ended")',
  SPACE_LIVE_INDICATOR:
    'span:has-text("LIVE"), [data-testid="SpaceLiveIndicator"]',
} as const;

export type SelectorKey = keyof typeof SELECTORS;
