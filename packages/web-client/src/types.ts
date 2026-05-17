// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas

export type Network =
  | 'solana'
  | 'solana-devnet'
  | 'base'
  | 'base-sepolia'
  | 'arbitrum'
  | 'ethereum'

export type WalletKind = 'phantom' | 'evm'

export interface PaymentRequirement {
  scheme: 'exact'
  network: Network
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: string
  payTo: string
  asset: string
  extra?: Record<string, unknown>
  maxTimeoutSeconds: number
}

export interface PaymentRequirementsResponse {
  x402Version: 1
  accepts: PaymentRequirement[]
  error?: string
}

export interface PaymentPayload {
  x402Version: 1
  scheme: 'exact'
  network: Network
  payload: unknown
}

export interface AskResponseEvent {
  questionId: string
  text: string
  audio: string | null
  source: 'agent' | 'direct'
  txHash?: string
  network?: string
  payer?: string
}

export interface AskErrorEvent {
  questionId: string
  error: string
}

export interface WalletAdapter {
  readonly kind: WalletKind
  readonly supports: (network: Network) => boolean
  isAvailable(): boolean
  connect(): Promise<{ address: string }>
  disconnect(): Promise<void>
  getAddress(): string | null
  /** Sign and produce an x402 payment payload for the given requirement. */
  buildPaymentPayload(requirement: PaymentRequirement): Promise<PaymentPayload>
}
