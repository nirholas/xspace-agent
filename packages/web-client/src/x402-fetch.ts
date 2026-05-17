// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas

import type {
  Network,
  PaymentPayload,
  PaymentRequirement,
  PaymentRequirementsResponse,
  WalletAdapter,
} from './types'

export interface X402FetchResult<T> {
  data: T
  status: number
  /** The settlement receipt sent back by the server (if any). */
  paymentResponse: { txHash?: string; networkId?: string; network?: Network } | null
}

export interface X402FetchOptions {
  /** Wallet adapters available to sign payments, in fallback order. */
  wallets: WalletAdapter[]
  /** Preferred network when the server accepts more than one. */
  preferredNetwork?: Network
}

/**
 * Fetch wrapper that completes an x402 payment flow transparently.
 *
 *   1. Send the initial request.
 *   2. If the server responds 402, decode the requirements.
 *   3. Pick a network we can pay (preferred → any matching wallet).
 *   4. Ask the wallet adapter to sign and produce a PaymentPayload.
 *   5. Retry the request with the base64-encoded X-PAYMENT header.
 */
export async function x402Fetch<T = unknown>(
  input: string,
  init: RequestInit,
  options: X402FetchOptions,
): Promise<X402FetchResult<T>> {
  const initial = await fetch(input, init)

  if (initial.status !== 402) {
    const data = (await initial.json().catch(() => ({}))) as T
    return { data, status: initial.status, paymentResponse: parsePaymentResponse(initial) }
  }

  const requirementsBody = (await initial.json()) as PaymentRequirementsResponse
  if (requirementsBody.x402Version !== 1) {
    throw new Error(`unsupported x402 version: ${requirementsBody.x402Version}`)
  }

  const { requirement, adapter } = pickRequirement(requirementsBody.accepts, options)
  const payload = await adapter.buildPaymentPayload(requirement)

  const paymentHeader = base64(JSON.stringify(payload satisfies PaymentPayload))
  const retried = await fetch(input, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'X-PAYMENT': paymentHeader,
    },
  })

  const data = (await retried.json().catch(() => ({}))) as T
  if (retried.status >= 400) {
    const errMsg = (data as any)?.error ?? `payment retry failed (${retried.status})`
    throw new Error(errMsg)
  }
  return {
    data,
    status: retried.status,
    paymentResponse: parsePaymentResponse(retried),
  }
}

function pickRequirement(
  requirements: PaymentRequirement[],
  options: X402FetchOptions,
): { requirement: PaymentRequirement; adapter: WalletAdapter } {
  if (requirements.length === 0) throw new Error('server offered no payment requirements')

  // Preference order: preferred network → any adapter that supports a requirement.
  const ordered = [...requirements].sort((a, b) => {
    if (options.preferredNetwork) {
      if (a.network === options.preferredNetwork && b.network !== options.preferredNetwork) return -1
      if (b.network === options.preferredNetwork && a.network !== options.preferredNetwork) return 1
    }
    return 0
  })

  for (const requirement of ordered) {
    const adapter = options.wallets.find(
      (w) => w.supports(requirement.network) && w.isAvailable(),
    )
    if (adapter) return { requirement, adapter }
  }

  const networks = ordered.map((r) => r.network).join(', ')
  throw new Error(`no connected wallet supports any offered network (${networks})`)
}

function parsePaymentResponse(
  res: Response,
): { txHash?: string; networkId?: string; network?: Network } | null {
  const header = res.headers.get('X-Payment-Response') ?? res.headers.get('x-payment-response')
  if (!header) return null
  try {
    const json = JSON.parse(atob(header))
    return {
      txHash: json.txHash,
      networkId: json.networkId,
      network: json.network,
    }
  } catch {
    return null
  }
}

function base64(input: string): string {
  if (typeof btoa === 'function') return btoa(input)
  return Buffer.from(input).toString('base64')
}
