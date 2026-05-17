// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

import type {
  PaymentPayload,
  PaymentRequirement,
  SettleResponse,
  VerifyResponse,
  X402Network,
} from './types'

/**
 * Abstract facilitator interface. Each implementation talks to a specific
 * x402 facilitator service (Sperax for EVM, CDP for Solana) over HTTP.
 */
export interface Facilitator {
  readonly name: string
  readonly supports: (network: X402Network) => boolean
  verify(payload: PaymentPayload, requirement: PaymentRequirement): Promise<VerifyResponse>
  settle(payload: PaymentPayload, requirement: PaymentRequirement): Promise<SettleResponse>
}

const EVM_NETWORKS: X402Network[] = ['base', 'base-sepolia', 'arbitrum', 'ethereum']
const SOLANA_NETWORKS: X402Network[] = ['solana', 'solana-devnet']

export function isEvmNetwork(n: X402Network): boolean {
  return EVM_NETWORKS.includes(n)
}

export function isSolanaNetwork(n: X402Network): boolean {
  return SOLANA_NETWORKS.includes(n)
}
