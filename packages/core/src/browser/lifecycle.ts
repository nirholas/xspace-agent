// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

import { EventEmitter } from 'events'
import type { Page } from 'puppeteer'
import type { AuthConfig, BrowserConfig } from '../types'
import { BrowserManager } from './launcher'
import { login } from './auth'
import * as spaceUI from './space-ui'
import type { SpaceUIOptions } from './space-ui'
import { injectAudioHooks } from '../audio/bridge'
import { SelectorEngine } from './selector-engine'
import { DOMObserver } from './observer'
import { SELECTOR_DEFINITIONS } from './selectors'
import { BrowserConnectionError } from '../errors'

export interface BrowserLifecycleEvents {
  status: (status: string) => void
  error: (error: Error) => void
}

export class BrowserLifecycle {
  private browserManager: BrowserManager | null = null
  private page: Page | null = null
  private readonly browserConfig?: BrowserConfig
  private readonly authConfig: AuthConfig
  private readonly emitter = new EventEmitter()

  private selectorEngine: SelectorEngine
  private observer: DOMObserver | null = null

  constructor(browserConfig: BrowserConfig | undefined, authConfig: AuthConfig) {
    this.browserConfig = browserConfig
    this.authConfig = authConfig
    this.selectorEngine = new SelectorEngine(SELECTOR_DEFINITIONS)
  }

  get isConnectMode(): boolean {
    return this.browserManager?.isConnectMode ?? false
  }

  async launch(onAudioData: (pcmBase64: string, sampleRate: number) => void): Promise<Page> {
    if (this.browserManager) {
      throw new BrowserConnectionError(
        this.browserConfig?.mode ?? 'managed',
        'Browser already launched. Call cleanup() first.',
      )
    }

    this.browserManager = new BrowserManager(this.browserConfig)
    const { page } = await this.browserManager.launch()
    this.page = page

    await injectAudioHooks(page, onAudioData, this.browserConfig?.mode)

    // Initialize CDP-based DOM observer
    this.observer = new DOMObserver(page, this.selectorEngine)
    await this.observer.start()

    return page
  }

  async authenticate(): Promise<void> {
    if (!this.page) throw new Error('Browser not launched')

    // Skip authentication in connect mode — already logged in via Chrome
    if (this.isConnectMode) {
      return
    }

    const internalEmitter = new EventEmitter()
    internalEmitter.on('status', (s: string) => {
      this.emitter.emit('status', s)
    })
    internalEmitter.on('2fa-required', () => {
      this.emitter.emit('error', new Error('2FA required — provide auth token instead of username/password'))
    })

    await login(this.page, this.authConfig, internalEmitter, {
      selectorEngine: this.selectorEngine,
    })
  }

  async joinSpace(spaceUrl: string): Promise<void> {
    if (!this.page) throw new Error('Browser not launched')

    const internalEmitter = new EventEmitter()
    internalEmitter.on('status', (s: string) => {
      this.emitter.emit('status', s)
    })

    const opts = this.getSpaceUIOptions()

    await spaceUI.joinSpace(this.page, spaceUrl, internalEmitter, opts)

    const speakerResult = await spaceUI.requestSpeaker(this.page, internalEmitter, opts)
    if (speakerResult === 'requested') {
      await spaceUI.waitForSpeakerAccess(this.page, internalEmitter, 300000, opts)
    } else if (speakerResult === 'granted') {
      await spaceUI.unmute(this.page, internalEmitter, opts)
    } else {
      await spaceUI.unmute(this.page, internalEmitter, opts)
    }
  }

  async leaveSpace(): Promise<void> {
    if (!this.page) return

    const internalEmitter = new EventEmitter()
    await spaceUI.leaveSpace(this.page, internalEmitter, this.getSpaceUIOptions())
  }

  async cleanup(): Promise<void> {
    if (this.observer) {
      await this.observer.stop()
      this.observer = null
    }
    if (this.browserManager) {
      await this.browserManager.close()
      this.browserManager = null
      this.page = null
    }
  }

  getPage(): Page | null {
    return this.page
  }

  getSelectorEngine(): SelectorEngine {
    return this.selectorEngine
  }

  getObserver(): DOMObserver | null {
    return this.observer
  }

  getSpaceUIOptions(): SpaceUIOptions {
    return {
      selectorEngine: this.selectorEngine,
      observer: this.observer ?? undefined,
    }
  }

  on<K extends keyof BrowserLifecycleEvents>(event: K, listener: BrowserLifecycleEvents[K]): void {
    this.emitter.on(event, listener)
  }
}
