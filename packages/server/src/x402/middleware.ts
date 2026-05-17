// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

import type { NextFunction, Request, Response } from 'express'
import { getAppLogger } from 'xspace-agent'

import { CdpFacilitator } from './cdp'
import type { Facilitator } from './facilitator'
import { SperaxFacilitator } from './sperax'
import type {
  PaymentPayload,
  PaymentRequirement,
  PaymentRequirementsResponse,
  X402Network,
} from './types'

// USDC contracts/mints per network (canonical addresses).
const USDC_ASSETS: Record<X402Network, { address: string; decimals: number }> = {
  base:           { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  'base-sepolia': { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 },
  arbitrum:       { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  ethereum:       { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  solana:         { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  'solana-devnet':{ address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6 },
}

export interface X402Config {
  /** Price in USDC base units (6 decimals). 10000 = $0.01 */
  priceUsdc: string
  /** Networks to accept, in display order. */
  networks: X402Network[]
  /** Recipient address per network (must be filled for every entry in `networks`). */
  recipients: Partial<Record<X402Network, string>>
  /** Description shown to the user's wallet. */
  description: string
  /** Sperax facilitator base URL. */
  speraxUrl: string
  /** CDP facilitator base URL + creds. Optional — Solana is skipped if absent. */
  cdpUrl?: string
  cdpApiKeyId?: string
  cdpApiKeySecret?: string
}

export function loadX402ConfigFromEnv(): X402Config | null {
  const price = process.env.X402_PRICE_USDC ?? '10000'

  const networks: X402Network[] = []
  const recipients: Partial<Record<X402Network, string>> = {}

  const solRecipient = process.env.SOLANA_RECIPIENT_ADDRESS?.trim()
  if (solRecipient && process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
    networks.push('solana')
    recipients.solana = solRecipient
  }

  const evmRecipient = process.env.EVM_RECIPIENT_ADDRESS?.trim()
  if (evmRecipient) {
    const evmNet = (process.env.X402_EVM_NETWORK ?? 'base').trim() as X402Network
    networks.push(evmNet)
    recipients[evmNet] = evmRecipient
  }

  if (networks.length === 0) return null

  return {
    priceUsdc: price,
    networks,
    recipients,
    description: 'Ask the AI agent a question',
    speraxUrl: process.env.X402_FACILITATOR_EVM ?? 'https://x402.sperax.io',
    cdpUrl: process.env.X402_FACILITATOR_SOLANA ?? 'https://api.cdp.coinbase.com/platform/v2/x402/facilitator',
    cdpApiKeyId: process.env.CDP_API_KEY_ID,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
  }
}

function buildFacilitators(config: X402Config): Facilitator[] {
  const facilitators: Facilitator[] = [new SperaxFacilitator(config.speraxUrl)]
  if (config.cdpUrl && config.cdpApiKeyId && config.cdpApiKeySecret) {
    facilitators.push(
      new CdpFacilitator(config.cdpUrl, {
        apiKeyId: config.cdpApiKeyId,
        apiKeySecret: config.cdpApiKeySecret,
      }),
    )
  }
  return facilitators
}

function buildRequirements(config: X402Config, resource: string): PaymentRequirement[] {
  return config.networks
    .filter((n) => config.recipients[n])
    .map((network) => {
      const asset = USDC_ASSETS[network]
      return {
        scheme: 'exact',
        network,
        maxAmountRequired: config.priceUsdc,
        resource,
        description: config.description,
        mimeType: 'application/json',
        payTo: config.recipients[network]!,
        asset: asset.address,
        extra: { name: 'USDC', version: '2', decimals: asset.decimals },
        maxTimeoutSeconds: 60,
      } satisfies PaymentRequirement
    })
}

function decodePaymentHeader(raw: string): PaymentPayload | null {
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8')
    const parsed = JSON.parse(decoded) as PaymentPayload
    if (parsed.x402Version !== 1) return null
    if (parsed.scheme !== 'exact') return null
    if (!parsed.network || !parsed.payload) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Express middleware that gates a route behind an x402 payment.
 *
 * Flow:
 *   1. No `X-PAYMENT` header → respond 402 with payment requirements.
 *   2. Header present → decode, dispatch to the matching facilitator,
 *      verify, settle, then attach the payment context to `req.x402`
 *      and call `next()`.
 *   3. Verification/settlement failure → respond 402 with the reason.
 */
export function x402Gate(config: X402Config) {
  const log = getAppLogger('x402')
  const facilitators = buildFacilitators(config)

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const resourceUrl = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`
    const requirements = buildRequirements(config, resourceUrl)

    if (requirements.length === 0) {
      res.status(503).json({ error: 'x402 not configured (no recipients set)' })
      return
    }

    const header = req.header('x-payment') ?? req.header('X-PAYMENT')
    if (!header) {
      const body: PaymentRequirementsResponse = { x402Version: 1, accepts: requirements }
      res.status(402).json(body)
      return
    }

    const payload = decodePaymentHeader(header)
    if (!payload) {
      const body: PaymentRequirementsResponse = {
        x402Version: 1,
        accepts: requirements,
        error: 'malformed X-PAYMENT header',
      }
      res.status(402).json(body)
      return
    }

    const requirement = requirements.find((r) => r.network === payload.network)
    if (!requirement) {
      res.status(402).json({
        x402Version: 1,
        accepts: requirements,
        error: `network ${payload.network} not accepted`,
      } satisfies PaymentRequirementsResponse)
      return
    }

    const facilitator = facilitators.find((f) => f.supports(payload.network))
    if (!facilitator) {
      res.status(503).json({ error: `no facilitator configured for ${payload.network}` })
      return
    }

    try {
      const verified = await facilitator.verify(payload, requirement)
      if (!verified.isValid) {
        res.status(402).json({
          x402Version: 1,
          accepts: requirements,
          error: verified.invalidReason ?? 'payment invalid',
        } satisfies PaymentRequirementsResponse)
        return
      }

      const settled = await facilitator.settle(payload, requirement)
      if (!settled.success) {
        res.status(402).json({
          x402Version: 1,
          accepts: requirements,
          error: settled.errorReason ?? 'settlement failed',
        } satisfies PaymentRequirementsResponse)
        return
      }

      req.x402 = {
        network: payload.network,
        payer: settled.payer ?? verified.payer ?? 'unknown',
        txHash: settled.txHash ?? '',
        amount: requirement.maxAmountRequired,
        asset: requirement.asset,
      }

      // Echo a settlement response header so the client can record the tx.
      const responseHeader = Buffer.from(
        JSON.stringify({
          success: true,
          txHash: settled.txHash,
          networkId: settled.networkId,
          network: payload.network,
        }),
      ).toString('base64')
      res.setHeader('X-Payment-Response', responseHeader)

      next()
    } catch (err: any) {
      log.error({ err: err.message, network: payload.network }, 'x402 facilitator error')
      res.status(502).json({ error: 'facilitator unreachable', detail: err.message })
    }
  }
}
