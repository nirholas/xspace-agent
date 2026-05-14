// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§69]

/**
 * NotebookLM DOM selectors with multiple fallback strategies.
 * NotebookLM's UI changes frequently — each selector has CSS, text, and aria fallbacks.
 *
 * Selectors verified against NotebookLM UI as of 2026-05.
 * When a selector breaks: add alternatives here rather than replacing existing ones.
 */

export interface SelectorSet {
  /** Primary CSS selector */
  css: string[]
  /** Visible text content to match (case-insensitive substring) */
  text?: string[]
  /** aria-label values to match */
  aria?: string[]
}

export const NLM_SELECTORS = {
  /** Audio Overview tab / panel trigger */
  audioOverviewTab: {
    css: [
      'notebook-audio-overview',
      '[data-test-id="audio-overview"]',
      '.audio-overview-container',
    ],
    text: ['Audio Overview', 'Podcast'],
    aria: ['Audio Overview'],
  } satisfies SelectorSet,

  /** Generate / Load podcast button */
  generateButton: {
    css: [
      'button[data-test-id="generate-audio"]',
      '.generate-audio-button',
      'button.generate-button',
    ],
    text: ['Generate', 'Create audio overview', 'Load'],
    aria: ['Generate audio overview'],
  } satisfies SelectorSet,

  /** Play button for the Audio Overview */
  playButton: {
    css: [
      'button[aria-label="Play"]',
      'button[data-test-id="play-button"]',
      '.audio-player-play-button',
      'mat-icon-button[aria-label="Play"]',
    ],
    text: [],
    aria: ['Play', 'Play audio overview'],
  } satisfies SelectorSet,

  /** Pause button (indicates audio is playing) */
  pauseButton: {
    css: [
      'button[aria-label="Pause"]',
      'button[data-test-id="pause-button"]',
      '.audio-player-pause-button',
    ],
    aria: ['Pause'],
  } satisfies SelectorSet,

  /** "Join" button for interactive mode */
  joinButton: {
    css: [
      'button[data-test-id="join-button"]',
      '.join-conversation-button',
      'button[aria-label*="Join"]',
    ],
    text: ['Join', 'Join conversation', 'Interact'],
    aria: ['Join conversation', 'Join'],
  } satisfies SelectorSet,

  /** Microphone button in interactive mode */
  micButton: {
    css: [
      'button[aria-label*="microphone"]',
      'button[aria-label*="Microphone"]',
      'button[data-test-id="mic-button"]',
      '.mic-toggle-button',
    ],
    aria: ['Microphone', 'Toggle microphone', 'Mute microphone'],
  } satisfies SelectorSet,

  /** End / Leave interactive session button */
  leaveButton: {
    css: [
      'button[data-test-id="leave-button"]',
      'button[aria-label*="Leave"]',
      '.leave-conversation-button',
    ],
    text: ['Leave', 'End', 'Stop'],
    aria: ['Leave conversation'],
  } satisfies SelectorSet,

  /** Audio player element — the underlying <audio> tag */
  audioElement: {
    css: ['audio', 'audio[src]', '#audio-player audio'],
  } satisfies SelectorSet,

  /** Audio progress / waveform indicator (confirms audio is loaded) */
  audioProgress: {
    css: [
      '.audio-progress',
      '.waveform-container',
      '[data-test-id="audio-waveform"]',
      '.audio-player-progress',
    ],
  } satisfies SelectorSet,

  /** "Generating..." spinner/indicator */
  generatingIndicator: {
    css: [
      '.generating-indicator',
      '[data-test-id="generating-status"]',
      'mat-progress-spinner',
    ],
    text: ['Generating', 'Loading'],
    aria: ['Generating audio overview'],
  } satisfies SelectorSet,
} as const

export type NLMSelectorKey = keyof typeof NLM_SELECTORS
