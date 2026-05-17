// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// x402 protocol types (https://www.x402.org)
// We support two facilitators:
//   - Sperax (EVM: Base, Arbitrum, Ethereum) — eip3009 / eip2612 settlement
//   - Coinbase CDP (Solana mainnet) — SPL token transfer settlement

export type X402Network =
  | 'base'
  | 'base-sepolia'
  | 'arbitrum'
  | 'ethereum'
  | 'solana'
  | 'solana-devnet'

export type X402Scheme = 'exact'

export interface PaymentRequirement {
  scheme: X402Scheme
  network: X402Network
  /** Amount in token base units (string to avoid bigint JSON issues). USDC has 6 decimals. */
  maxAmountRequired: string
  /** Resource URL the payment grants access to. */
  resource: string
  description: string
  mimeType: string
  /** Wallet that receives the payment. */
  payTo: string
  /** Token contract / mint address. */
  asset: string
  /** Decimals of the asset (USDC = 6). */
  extra?: Record<string, unknown>
  maxTimeoutSeconds: number
}

export interface PaymentRequirementsResponse {
  x402Version: 1
  accepts: PaymentRequirement[]
  /** Optional human-readable error for clients that don't speak x402. */
  error?: string
}

/**
 * The decoded body of the `X-PAYMENT` header. The exact shape of `payload` is
 * network-specific (EIP-3009 auth for EVM, signed transaction blob for Solana).
 */
export interface PaymentPayload {
  x402Version: 1
  scheme: X402Scheme
  network: X402Network
  payload: unknown
}

export interface VerifyResponse {
  isValid: boolean
  invalidReason?: string
  payer?: string
}

export interface SettleResponse {
  success: boolean
  errorReason?: string
  txHash?: string
  networkId?: string
  payer?: string
}

/** Attached to req after successful x402 settlement. */
export interface X402PaymentContext {
  network: X402Network
  payer: string
  txHash: string
  amount: string
  asset: string
}

declare global {
  namespace Express {
    interface Request {
      x402?: X402PaymentContext
    }
  }
}
