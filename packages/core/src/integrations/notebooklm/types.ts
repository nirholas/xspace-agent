// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§69]

export type NotebookLMState =
  | 'idle'
  | 'launching'
  | 'authenticating'
  | 'navigating'
  | 'generating'
  | 'playing'
  | 'interactive'
  | 'stopped'
  | 'error'

export interface NotebookLMConfig {
  /** Full URL to the NotebookLM notebook, e.g. https://notebooklm.google.com/notebook/abc123 */
  notebookUrl: string
  /**
   * Google account cookies for authentication.
   * Required fields: __Secure-1PSID, __Secure-1PAPISID (or SID + SAPISID).
   * Obtain from a logged-in Chrome session via DevTools → Application → Cookies.
   */
  googleCookies: GoogleCookies
  /**
   * If true, generate a new Audio Overview if one doesn't exist yet.
   * Default: false — only use an already-generated overview.
   */
  autoGenerate?: boolean
  /**
   * Enable interactive mode — allows X Space participants to speak to the AI hosts.
   * Requires NotebookLM to support the "Join" interactive feature.
   * Default: true
   */
  interactive?: boolean
  /**
   * Timeout in ms to wait for the Audio Overview to start playing.
   * Default: 60_000
   */
  playbackTimeoutMs?: number
  /** Chrome user data directory for persistent Google session. Optional. */
  userDataDir?: string
}

export interface GoogleCookies {
  /** Primary session cookie */
  SID?: string
  HSID?: string
  SSID?: string
  APISID?: string
  SAPISID?: string
  /** Secure variants (preferred) */
  '__Secure-1PSID'?: string
  '__Secure-1PAPISID'?: string
  '__Secure-3PSID'?: string
  '__Secure-3PAPISID'?: string
  /** Additional cookies — any extra Google cookies to set */
  [key: string]: string | undefined
}

export interface NotebookLMBridgeEvents {
  /** Fired when the bridge state changes */
  state: (state: NotebookLMState) => void
  /** Fired when a podcast audio chunk is ready (MP3 buffer) — inject into X Space */
  audio: (mp3: Buffer) => void
  /** Fired when the Audio Overview starts playing */
  playing: () => void
  /** Fired when the Audio Overview ends */
  ended: () => void
  /** Fired when interactive mode is active and the AI hosts are ready for input */
  interactive: () => void
  /** Fired on error */
  error: (err: Error) => void
  /** Debug log messages */
  log: (msg: string) => void
}
