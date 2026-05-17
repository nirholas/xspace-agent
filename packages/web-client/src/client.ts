// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas

import { io, type Socket } from 'socket.io-client'

import type {
  AskErrorEvent,
  AskResponseEvent,
  Network,
  WalletAdapter,
  WalletKind,
} from './types'
import { x402Fetch } from './x402-fetch'
import { EvmAdapter } from './wallet/evm'
import { PhantomAdapter } from './wallet/phantom'

export interface XSpaceAskClientConfig {
  /** Base URL of the xspace-agent server (e.g. https://api.xspace.dev). */
  apiUrl: string
  /** Override the Socket.IO URL if it differs from apiUrl. */
  socketUrl?: string
  /** Preferred payment network. Default: 'solana'. */
  preferredNetwork?: Network
  /** Solana RPC endpoint. Default: mainnet-beta public RPC. */
  solanaRpcUrl?: string
  /** Optional bearer/API key forwarded with the ask request (rare). */
  apiKey?: string
}

export interface AskResult {
  questionId: string
  paidWith: {
    network: Network
    txHash: string
    amount: string
    asset: string
  }
}

type Listener<T> = (ev: T) => void

/**
 * High-level client that handles:
 *   - Wallet detection (Phantom for Solana, injected EVM for Base/Arbitrum/Ethereum)
 *   - x402 payment flow on POST /api/ask
 *   - Socket.IO subscription to receive the agent's response (text + audio)
 *
 * Usage:
 *   const client = new XSpaceAskClient({ apiUrl: 'https://api.xspace.dev' })
 *   client.on('response', ({ text, audio }) => avatar.speak(audio, text))
 *   await client.connect('phantom')
 *   await client.ask("hi bot")
 */
export class XSpaceAskClient {
  private readonly config: Required<
    Pick<XSpaceAskClientConfig, 'apiUrl' | 'preferredNetwork'>
  > & XSpaceAskClientConfig

  private socket: Socket | null = null
  private phantom: PhantomAdapter
  private evm: EvmAdapter
  private active: WalletAdapter | null = null

  private responseListeners = new Set<Listener<AskResponseEvent>>()
  private errorListeners = new Set<Listener<AskErrorEvent>>()
  private pending = new Map<string, (ev: AskResponseEvent | AskErrorEvent) => void>()

  constructor(config: XSpaceAskClientConfig) {
    this.config = {
      preferredNetwork: 'solana',
      ...config,
    }
    this.phantom = new PhantomAdapter({ rpcUrl: this.config.solanaRpcUrl })
    this.evm = new EvmAdapter()
  }

  // ── Wallet management ───────────────────────────────────────────────────

  /** Returns which wallet kinds are installed in the user's browser. */
  available(): WalletKind[] {
    const available: WalletKind[] = []
    if (this.phantom.isAvailable()) available.push('phantom')
    if (this.evm.isAvailable()) available.push('evm')
    return available
  }

  /** Connect a specific wallet. If kind is omitted, prefer Phantom, else EVM. */
  async connect(kind?: WalletKind): Promise<{ kind: WalletKind; address: string }> {
    const chosen = kind ?? (this.phantom.isAvailable() ? 'phantom' : 'evm')
    const adapter = chosen === 'phantom' ? this.phantom : this.evm
    if (!adapter.isAvailable()) {
      throw new Error(`${chosen} wallet not detected`)
    }
    const { address } = await adapter.connect()
    this.active = adapter
    return { kind: chosen, address }
  }

  async disconnect(): Promise<void> {
    await this.active?.disconnect()
    this.active = null
  }

  getActive(): { kind: WalletKind; address: string } | null {
    if (!this.active) return null
    const address = this.active.getAddress()
    if (!address) return null
    return { kind: this.active.kind, address }
  }

  // ── Ask ─────────────────────────────────────────────────────────────────

  /**
   * Pay and submit a question. Resolves with the questionId and tx receipt
   * once the payment is settled. The actual answer arrives asynchronously
   * via the 'response' event.
   */
  async ask(question: string): Promise<AskResult> {
    this.ensureSocket()

    const wallets: WalletAdapter[] = [this.phantom, this.evm].filter((w) => w.isAvailable())
    if (wallets.length === 0) {
      throw new Error('no wallet detected — install Phantom or MetaMask')
    }

    const url = `${this.config.apiUrl.replace(/\/$/, '')}/api/ask`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers['X-API-Key'] = this.config.apiKey

    const result = await x402Fetch<AskResult>(
      url,
      { method: 'POST', headers, body: JSON.stringify({ question }) },
      {
        wallets,
        preferredNetwork: this.config.preferredNetwork,
      },
    )

    if (!result.data?.questionId) {
      throw new Error('server did not return a questionId')
    }
    return result.data
  }

  /**
   * Like ask(), but returns a promise that resolves with the answer itself.
   * Useful for callers that don't want to subscribe to events.
   */
  async askAndWait(
    question: string,
    options: { timeoutMs?: number } = {},
  ): Promise<AskResponseEvent> {
    const timeoutMs = options.timeoutMs ?? 60_000
    const { questionId } = await this.ask(question)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(questionId)
        reject(new Error('ask timeout'))
      }, timeoutMs)

      this.pending.set(questionId, (ev) => {
        clearTimeout(timer)
        if ('error' in ev) reject(new Error(ev.error))
        else resolve(ev)
      })
    })
  }

  // ── Events ──────────────────────────────────────────────────────────────

  on(event: 'response', listener: Listener<AskResponseEvent>): () => void
  on(event: 'error', listener: Listener<AskErrorEvent>): () => void
  on(event: 'response' | 'error', listener: any): () => void {
    this.ensureSocket()
    if (event === 'response') {
      this.responseListeners.add(listener)
      return () => this.responseListeners.delete(listener)
    }
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  /** Tear down the Socket.IO connection. */
  destroy(): void {
    this.socket?.disconnect()
    this.socket = null
    this.responseListeners.clear()
    this.errorListeners.clear()
    this.pending.clear()
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private ensureSocket(): void {
    if (this.socket) return
    const socketUrl = this.config.socketUrl ?? this.config.apiUrl
    const socket = io(`${socketUrl}/space`, {
      transports: ['websocket'],
      auth: this.config.apiKey ? { apiKey: this.config.apiKey } : undefined,
    })

    socket.on('ask:response', (ev: AskResponseEvent) => {
      const pending = this.pending.get(ev.questionId)
      if (pending) {
        this.pending.delete(ev.questionId)
        pending(ev)
      }
      for (const fn of this.responseListeners) fn(ev)
    })

    socket.on('ask:error', (ev: AskErrorEvent) => {
      const pending = this.pending.get(ev.questionId)
      if (pending) {
        this.pending.delete(ev.questionId)
        pending(ev)
      }
      for (const fn of this.errorListeners) fn(ev)
    })

    this.socket = socket
  }
}
