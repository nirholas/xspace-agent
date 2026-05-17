// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// Sperax x402 facilitator — supports EVM USDC on Base, Arbitrum, Ethereum.
// Settlement via EIP-3009 transferWithAuthorization.
// Docs: https://x402.sperax.io  (endpoints: /verify, /settle, /supported)

import type { Facilitator } from './facilitator'
import { isEvmNetwork } from './facilitator'
import type {
  PaymentPayload,
  PaymentRequirement,
  SettleResponse,
  VerifyResponse,
} from './types'

export class SperaxFacilitator implements Facilitator {
  readonly name = 'sperax'

  constructor(private readonly baseUrl: string) {}

  supports(network: PaymentRequirement['network']): boolean {
    return isEvmNetwork(network)
  }

  async verify(payload: PaymentPayload, requirement: PaymentRequirement): Promise<VerifyResponse> {
    const r = await this.post('/verify', { paymentPayload: payload, paymentRequirements: requirement })
    return {
      isValid: Boolean(r.isValid),
      invalidReason: r.invalidReason,
      payer: r.payer,
    }
  }

  async settle(payload: PaymentPayload, requirement: PaymentRequirement): Promise<SettleResponse> {
    const r = await this.post('/settle', { paymentPayload: payload, paymentRequirements: requirement })
    return {
      success: Boolean(r.success),
      errorReason: r.errorReason,
      txHash: r.txHash,
      networkId: r.networkId,
      payer: r.payer,
    }
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`sperax ${path} ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  }
}
