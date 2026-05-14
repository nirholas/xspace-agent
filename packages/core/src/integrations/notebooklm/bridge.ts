// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent) [§69]

// =============================================================================
// NotebookLM Bridge
// =============================================================================
//
// Connects a Google NotebookLM Audio Overview to an X Space session.
// Opens NotebookLM in a Puppeteer page, captures the podcast audio stream,
// and routes it bidirectionally with an X Space:
//
//   NotebookLM Audio Overview → X Space  (AI hosts speak in the Space)
//   X Space participant speech → NotebookLM interactive mode  (participants talk to hosts)
//
// Usage:
//   const bridge = new NotebookLMBridge(browser, config)
//   bridge.on('audio', async (mp3) => injectAudio(spacePage, mp3))
//   await bridge.start()
//   // later:
//   await bridge.injectSpeech(pcmFloat32Buffer)  // route Space speech → NotebookLM mic

import { EventEmitter } from 'events'
import type { Browser, Page } from 'puppeteer'
import { getAppLogger } from '../../observability/logger'
import { notebookLMAudioHooksCode } from './audio-hooks'
import { NLM_SELECTORS } from './ui-selectors'
import type { NotebookLMConfig, NotebookLMState, NotebookLMBridgeEvents } from './types'
import { pcmChunksToWav } from '../../audio/bridge'

const GOOGLE_DOMAINS = [
  'google.com',
  'notebooklm.google.com',
  'accounts.google.com',
]

export declare interface NotebookLMBridge {
  on<K extends keyof NotebookLMBridgeEvents>(event: K, listener: NotebookLMBridgeEvents[K]): this
  emit<K extends keyof NotebookLMBridgeEvents>(event: K, ...args: Parameters<NotebookLMBridgeEvents[K]>): boolean
}

export class NotebookLMBridge extends EventEmitter {
  private page: Page | null = null
  private state: NotebookLMState = 'idle'
  private readonly log = getAppLogger('notebooklm')
  private audioBuffer: Buffer[] = []
  private audioFlushTimer: ReturnType<typeof setInterval> | null = null
  private playbackMonitor: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly browser: Browser,
    private readonly config: NotebookLMConfig,
  ) {
    super()
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Launch NotebookLM, authenticate, and start the Audio Overview. */
  async start(): Promise<void> {
    this.setState('launching')

    try {
      this.page = await this.browser.newPage()
      await this.installAudioHooks()

      this.setState('authenticating')
      await this.authenticate()

      this.setState('navigating')
      await this.navigate()

      await this.openAudioOverview()

      if (this.config.autoGenerate) {
        await this.maybeGenerate()
      }

      await this.play()
      this.setState('playing')
      this.startPlaybackMonitor()

      if (this.config.interactive !== false) {
        await this.enableInteractive()
      }
    } catch (err: any) {
      this.setState('error')
      this.log.error({ err }, 'NotebookLM bridge failed to start')
      this.emit('error', err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  /**
   * Inject X Space participant speech into NotebookLM's interactive mode.
   * Call this from the agent's transcription handler when a participant speaks.
   * @param pcmFloat32 PCM Float32 audio data at 48kHz (as returned by the audio pipeline)
   */
  async injectSpeech(pcmFloat32: Float32Array): Promise<void> {
    if (!this.page || (this.state !== 'interactive' && this.state !== 'playing')) return

    const bytes = new Uint8Array(pcmFloat32.buffer)
    let binary = ''
    const step = 8192
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + step)))
    }
    const b64 = Buffer.from(binary, 'binary').toString('base64')

    await this.page.evaluate((pcmB64: string) => {
      if ((window as any).__nlmInjectPCM) {
        ;(window as any).__nlmInjectPCM(pcmB64)
      }
    }, b64)
  }

  /** Stop the bridge, close the NotebookLM page, and clean up. */
  async stop(): Promise<void> {
    this.clearTimers()
    if (this.page) {
      try {
        await this.page.evaluate(() => {
          if ((window as any).__nlmDispose) (window as any).__nlmDispose()
        })
        await this.page.close()
      } catch {
        // ignore cleanup errors
      }
      this.page = null
    }
    this.setState('stopped')
    this.log.info('NotebookLM bridge stopped')
  }

  get currentState(): NotebookLMState {
    return this.state
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  private async installAudioHooks(): Promise<void> {
    if (!this.page) return

    // Expose Node callback — called by browser JS when podcast audio is captured
    await this.page.exposeFunction(
      '__onNLMAudio',
      (pcmBase64: string, sampleRate: number) => {
        this.handleAudioChunk(pcmBase64, sampleRate)
      },
    )
    await this.page.exposeFunction('__nlmLog', (msg: string) => {
      this.log.debug({ msg }, 'NLM browser log')
      this.emit('log', msg)
    })

    // Inject hooks before any page script runs
    await this.page.evaluateOnNewDocument(notebookLMAudioHooksCode)
    this.log.debug('NotebookLM audio hooks installed')
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  private async authenticate(): Promise<void> {
    if (!this.page) return
    const { googleCookies } = this.config

    if (!googleCookies || Object.keys(googleCookies).length === 0) {
      this.log.warn('No Google cookies provided — NotebookLM may require manual login')
      return
    }

    const cookies = Object.entries(googleCookies)
      .filter(([, v]) => v !== undefined)
      .flatMap(([name, value]) =>
        GOOGLE_DOMAINS.map((domain) => ({
          name,
          value: value as string,
          domain,
          path: '/',
          httpOnly: name.startsWith('__Secure') || name === 'SID' || name === 'HSID',
          secure: name.startsWith('__Secure') || name === 'SSID',
          sameSite: 'None' as const,
        })),
      )

    await this.page.setCookie(...cookies)
    this.log.info({ cookieCount: Object.keys(googleCookies).length }, 'Google cookies set')
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  private async navigate(): Promise<void> {
    if (!this.page) return

    this.log.info({ url: this.config.notebookUrl }, 'Navigating to NotebookLM notebook')
    await this.page.goto(this.config.notebookUrl, {
      waitUntil: 'networkidle2',
      timeout: 60_000,
    })

    // Check for redirect to login — if we ended up on accounts.google.com, cookies didn't work
    const url = this.page.url()
    if (url.includes('accounts.google.com')) {
      throw new Error(
        'NotebookLM authentication failed — redirected to Google login. ' +
          'Provide valid Google cookies via config.googleCookies.',
      )
    }

    this.log.info({ url: this.page.url() }, 'Notebook loaded')
  }

  // ---------------------------------------------------------------------------
  // Audio Overview UI automation
  // ---------------------------------------------------------------------------

  private async openAudioOverview(): Promise<void> {
    if (!this.page) return

    // Try each selector strategy for the Audio Overview panel
    const opened = await this.tryClick(NLM_SELECTORS.audioOverviewTab)
    if (opened) {
      this.log.debug('Audio Overview panel opened')
      await this.wait(1000)
    }
    // If not found, assume the panel is already open or auto-visible
  }

  private async maybeGenerate(): Promise<void> {
    if (!this.page) return

    const generateVisible = await this.isVisible(NLM_SELECTORS.generateButton)
    if (!generateVisible) return

    this.log.info('Generating Audio Overview...')
    await this.tryClick(NLM_SELECTORS.generateButton)
    this.setState('generating')

    // Wait for generation to complete (up to 3 minutes)
    const started = Date.now()
    while (Date.now() - started < 180_000) {
      const stillGenerating = await this.isVisible(NLM_SELECTORS.generatingIndicator)
      if (!stillGenerating) {
        this.log.info('Audio Overview generation complete')
        break
      }
      await this.wait(3000)
    }
  }

  private async play(): Promise<void> {
    if (!this.page) return

    const timeoutMs = this.config.playbackTimeoutMs ?? 60_000

    // Wait for the play button to appear
    const playVisible = await this.waitForVisible(NLM_SELECTORS.playButton, timeoutMs)
    if (!playVisible) {
      throw new Error(
        `Audio Overview play button not found within ${timeoutMs}ms. ` +
          'The notebook may not have a generated Audio Overview yet. ' +
          'Set config.autoGenerate = true to generate one automatically.',
      )
    }

    await this.tryClick(NLM_SELECTORS.playButton)
    this.log.info('Audio Overview playback started')
    this.emit('playing')
  }

  private async enableInteractive(): Promise<void> {
    if (!this.page) return

    // Wait up to 10s for the Join button to appear (it shows after a few seconds of playback)
    const joinVisible = await this.waitForVisible(NLM_SELECTORS.joinButton, 10_000)
    if (!joinVisible) {
      this.log.debug('Interactive Join button not found — interactive mode unavailable')
      return
    }

    await this.tryClick(NLM_SELECTORS.joinButton)
    await this.wait(1500) // wait for mic permissions dialog

    // Click mic button to unmute (interactive mode starts muted)
    await this.tryClick(NLM_SELECTORS.micButton)

    this.setState('interactive')
    this.emit('interactive')
    this.log.info('NotebookLM interactive mode enabled')
  }

  // ---------------------------------------------------------------------------
  // Audio pipeline
  // ---------------------------------------------------------------------------

  /** Called from browser-side hook for each PCM audio chunk from the podcast */
  private handleAudioChunk(pcmBase64: string, _sampleRate: number): void {
    try {
      const buf = Buffer.from(pcmBase64, 'base64')
      this.audioBuffer.push(buf)

      // Accumulate ~200ms of audio before emitting (200ms @ 16kHz @ 4 bytes = 12800 bytes)
      const totalBytes = this.audioBuffer.reduce((s, b) => s + b.length, 0)
      if (totalBytes >= 12_800) {
        this.flushAudio()
      }
    } catch (err: any) {
      this.log.warn({ err }, 'Failed to process NLM audio chunk')
    }
  }

  private flushAudio(): void {
    if (this.audioBuffer.length === 0) return
    const chunks = this.audioBuffer.splice(0)

    // Convert PCM Float32 chunks → WAV → emit as 'audio' event
    // Consumers (e.g., XSpaceAgent) receive WAV buffers compatible with injectAudio()
    try {
      const wav = pcmChunksToWav(chunks, 16_000)
      this.emit('audio', wav)
    } catch (err: any) {
      this.log.warn({ err }, 'Failed to convert NLM audio to WAV')
    }
  }

  // ---------------------------------------------------------------------------
  // Playback monitoring
  // ---------------------------------------------------------------------------

  private startPlaybackMonitor(): void {
    this.playbackMonitor = setInterval(async () => {
      if (!this.page) return
      try {
        const playbackState = await this.page.evaluate(() => {
          if ((window as any).__nlmGetPlaybackState) {
            return (window as any).__nlmGetPlaybackState()
          }
          return null
        })

        if (playbackState?.ended) {
          this.log.info('Audio Overview playback ended')
          this.emit('ended')
          this.clearTimers()
        }
      } catch {
        // Page closed or navigated away
        this.clearTimers()
      }
    }, 2000)
  }

  // ---------------------------------------------------------------------------
  // Selector helpers
  // ---------------------------------------------------------------------------

  private async tryClick(selector: { css: string[]; text?: string[]; aria?: string[] }): Promise<boolean> {
    if (!this.page) return false

    // Try CSS selectors first
    for (const css of selector.css) {
      try {
        const el = await this.page.$(css)
        if (el) {
          await el.click()
          return true
        }
      } catch {
        // continue
      }
    }

    // Try text matching
    if (selector.text) {
      for (const text of selector.text) {
        try {
          const found = await this.page.evaluate((t: string) => {
            const els = Array.from(document.querySelectorAll('button, [role="button"], a'))
            const match = els.find((el) =>
              el.textContent?.trim().toLowerCase().includes(t.toLowerCase()),
            )
            if (match) {
              (match as HTMLElement).click()
              return true
            }
            return false
          }, text)
          if (found) return true
        } catch {
          // continue
        }
      }
    }

    // Try aria-label matching
    if (selector.aria) {
      for (const aria of selector.aria) {
        try {
          const el = await this.page.$(`[aria-label="${aria}"]`)
          if (el) {
            await el.click()
            return true
          }
        } catch {
          // continue
        }
      }
    }

    return false
  }

  private async isVisible(selector: { css: string[]; text?: string[] }): Promise<boolean> {
    if (!this.page) return false
    for (const css of selector.css) {
      try {
        const el = await this.page.$(css)
        if (el) return true
      } catch {
        // continue
      }
    }
    return false
  }

  private async waitForVisible(
    selector: { css: string[]; text?: string[]; aria?: string[] },
    timeoutMs: number,
  ): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const visible = await this.isVisible(selector)
      if (visible) return true
      await this.wait(500)
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private setState(state: NotebookLMState): void {
    this.state = state
    this.emit('state', state)
    this.log.debug({ state }, 'NotebookLM bridge state changed')
  }

  private clearTimers(): void {
    if (this.audioFlushTimer) {
      clearInterval(this.audioFlushTimer)
      this.audioFlushTimer = null
    }
    if (this.playbackMonitor) {
      clearInterval(this.playbackMonitor)
      this.playbackMonitor = null
    }
    // Flush any remaining buffered audio
    this.flushAudio()
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
