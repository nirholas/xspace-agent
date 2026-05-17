// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// Coinbase Developer Platform x402 facilitator — supports Solana mainnet USDC.
// Authenticated via Ed25519-signed JWT in the Authorization header.
// Docs: https://docs.cdp.coinbase.com/

import { createPrivateKey, sign as cryptoSign, randomBytes } from 'crypto'

import type { Facilitator } from './facilitator'
import { isSolanaNetwork } from './facilitator'
import type {
  PaymentPayload,
  PaymentRequirement,
  SettleResponse,
  VerifyResponse,
} from './types'

export interface CdpCredentials {
  /** UUID-format API Key ID from the CDP dashboard. */
  apiKeyId: string
  /** Base64-encoded Ed25519 private key from the CDP dashboard. */
  apiKeySecret: string
}

export class CdpFacilitator implements Facilitator {
  readonly name = 'cdp'

  constructor(
    private readonly baseUrl: string,
    private readonly creds: CdpCredentials,
  ) {}

  supports(network: PaymentRequirement['network']): boolean {
    return isSolanaNetwork(network)
  }

  async verify(payload: PaymentPayload, requirement: PaymentRequirement): Promise<VerifyResponse> {
    const r = await this.signedPost('/verify', {
      paymentPayload: payload,
      paymentRequirements: requirement,
    })
    return {
      isValid: Boolean(r.isValid),
      invalidReason: r.invalidReason,
      payer: r.payer,
    }
  }

  async settle(payload: PaymentPayload, requirement: PaymentRequirement): Promise<SettleResponse> {
    const r = await this.signedPost('/settle', {
      paymentPayload: payload,
      paymentRequirements: requirement,
    })
    return {
      success: Boolean(r.success),
      errorReason: r.errorReason,
      txHash: r.txHash,
      networkId: r.networkId,
      payer: r.payer,
    }
  }

  private async signedPost(path: string, body: unknown): Promise<any> {
    const url = new URL(this.baseUrl + path)
    const jwt = this.buildJwt('POST', url.host, url.pathname)
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`cdp ${path} ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  }

  /**
   * CDP's authentication uses an Ed25519-signed JWT. Token format:
   *   header  = { alg: 'EdDSA', typ: 'JWT', kid: apiKeyId, nonce: <hex> }
   *   payload = { sub: apiKeyId, iss: 'cdp', aud: ['cdp_service'],
   *               nbf, iat, exp: iat+120, uris: ['<METHOD> <host><path>'] }
   *
   * The secret is a base64-encoded Ed25519 seed (32 or 64 bytes).
   */
  private buildJwt(method: string, host: string, path: string): string {
    const now = Math.floor(Date.now() / 1000)
    const header = {
      alg: 'EdDSA',
      typ: 'JWT',
      kid: this.creds.apiKeyId,
      nonce: randomBytes(16).toString('hex'),
    }
    const payload = {
      sub: this.creds.apiKeyId,
      iss: 'cdp',
      aud: ['cdp_service'],
      nbf: now,
      iat: now,
      exp: now + 120,
      uris: [`${method.toUpperCase()} ${host}${path}`],
    }

    const encHeader = base64url(JSON.stringify(header))
    const encPayload = base64url(JSON.stringify(payload))
    const signingInput = `${encHeader}.${encPayload}`

    const keyObject = parseEd25519PrivateKey(this.creds.apiKeySecret)
    const signature = cryptoSign(null, Buffer.from(signingInput), keyObject)
    const encSignature = signature
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')

    return `${signingInput}.${encSignature}`
  }
}

function base64url(input: string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/**
 * Accept the CDP secret in two formats:
 *   1. Raw base64-encoded Ed25519 seed (32 bytes) — what the CDP UI emits.
 *   2. PEM-encoded PKCS#8 private key — what older keys used.
 */
function parseEd25519PrivateKey(secret: string): Parameters<typeof cryptoSign>[2] {
  const trimmed = secret.trim()
  if (trimmed.startsWith('-----BEGIN')) {
    return createPrivateKey({ key: trimmed, format: 'pem' })
  }
  const raw = Buffer.from(trimmed, 'base64')
  // 32-byte seed → wrap in PKCS#8 DER prefix for Ed25519
  if (raw.length === 32) {
    const prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
    const der = Buffer.concat([prefix, raw])
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  }
  // 64-byte expanded keys: first 32 bytes are the seed
  if (raw.length === 64) {
    const seed = raw.subarray(0, 32)
    const prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
    const der = Buffer.concat([prefix, seed])
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
  }
  throw new Error(`CDP_API_KEY_SECRET: unexpected key length ${raw.length} (expected 32 or 64 bytes, or PEM)`)
}
