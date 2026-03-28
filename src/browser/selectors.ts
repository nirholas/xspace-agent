// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// X/Twitter Space UI selectors
// Isolated here so they're easy to update when X changes their DOM

export const selectors = {
  // Login flow
  LOGIN_USERNAME_INPUT: 'input[autocomplete="username"]',
  LOGIN_NEXT_BUTTON: 'button:has-text("Next"), [role="button"] span:has-text("Next")',
  LOGIN_PASSWORD_INPUT: 'input[name="password"], input[type="password"]',
  LOGIN_SUBMIT_BUTTON: '[data-testid="LoginForm_Login_Button"]',
  VERIFY_EMAIL_INPUT: 'input[data-testid="ocfEnterTextTextInput"]',
  VERIFY_NEXT_BUTTON: '[data-testid="ocfEnterTextNextButton"]',

  // Home feed (confirms login success)
  HOME_TIMELINE: '[data-testid="primaryColumn"]',
  HOME_URL: "https://x.com/home",

  // Space UI
  SPACE_JOIN_BUTTON: '[data-testid="SpaceJoinButton"], button[aria-label*="Listen"], button[aria-label*="Join"]',
  SPACE_REQUEST_SPEAK: 'button[aria-label*="Request"], button[aria-label*="request to speak"]',
  SPACE_UNMUTE_BUTTON: '[data-testid="SpaceMuteButton"], button[aria-label*="Unmute"], button[aria-label*="unmute"]',
  SPACE_MUTE_BUTTON: '[data-testid="SpaceMuteButton"], button[aria-label*="Mute"]',
  SPACE_LEAVE_BUTTON: '[data-testid="SpaceLeaveButton"], button[aria-label*="Leave"]',
  SPACE_MIC_BUTTON: 'button[aria-label*="microphone"], button[aria-label*="Microphone"], button[aria-label="Unmute"], button[aria-label="Mute"]',
  SPACE_SPEAKER_LIST: '[data-testid="SpaceSpeakerAvatar"]',

  // Space state detection
  SPACE_ENDED_TEXT: 'span:has-text("This Space has ended"), span:has-text("Space ended")',
  SPACE_LIVE_INDICATOR: 'span:has-text("LIVE"), [data-testid="SpaceLiveIndicator"]',
} as const

export type SelectorKey = keyof typeof selectors
