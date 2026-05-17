// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas

import type {
  Network,
  PaymentPayload,
  PaymentRequirement,
  WalletAdapter,
} from '../types'

interface EthRequest {
  method: string
  params?: unknown[]
}

interface EthereumProvider {
  request<T = unknown>(args: EthRequest): Promise<T>
  isMetaMask?: boolean
  isCoinbaseWallet?: boolean
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
  }
}

// EVM chain IDs for the x402 networks we support.
const CHAIN_IDS: Partial<Record<Network, number>> = {
  base: 8453,
  'base-sepolia': 84532,
  arbitrum: 42161,
  ethereum: 1,
}

/**
 * Injected EVM wallet adapter. Works with MetaMask, Coinbase Wallet, or any
 * EIP-1193-compatible window.ethereum provider.
 *
 * Settlement: EIP-3009 `TransferWithAuthorization`, signed via eth_signTypedData_v4.
 */
export class EvmAdapter implements WalletAdapter {
  readonly kind = 'evm' as const

  private address: string | null = null

  supports(network: Network): boolean {
    return network in CHAIN_IDS
  }

  isAvailable(): boolean {
    return typeof window !== 'undefined' && !!window.ethereum
  }

  async connect(): Promise<{ address: string }> {
    const provider = window.ethereum
    if (!provider) throw new Error('No injected EVM wallet detected')
    const accounts = await provider.request<string[]>({ method: 'eth_requestAccounts' })
    const address = accounts?.[0]
    if (!address) throw new Error('Wallet returned no accounts')
    this.address = address
    return { address }
  }

  async disconnect(): Promise<void> {
    this.address = null
  }

  getAddress(): string | null {
    return this.address
  }

  async buildPaymentPayload(requirement: PaymentRequirement): Promise<PaymentPayload> {
    if (!this.supports(requirement.network)) {
      throw new Error(`EvmAdapter does not support network ${requirement.network}`)
    }
    const provider = window.ethereum
    if (!provider) throw new Error('No injected EVM wallet detected')
    if (!this.address) await this.connect()
    if (!this.address) throw new Error('EVM connect did not return an address')

    const chainId = CHAIN_IDS[requirement.network]!
    await ensureChain(provider, chainId)

    const now = Math.floor(Date.now() / 1000)
    const authorization = {
      from: this.address,
      to: requirement.payTo,
      value: requirement.maxAmountRequired,
      validAfter: String(now - 5),
      validBefore: String(now + requirement.maxTimeoutSeconds + 60),
      nonce: randomBytes32(),
    }

    const name = (requirement.extra?.name as string | undefined) ?? 'USD Coin'
    const version = (requirement.extra?.version as string | undefined) ?? '2'

    const typedData = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      domain: {
        name,
        version,
        chainId,
        verifyingContract: requirement.asset,
      },
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    }

    const signature = await provider.request<string>({
      method: 'eth_signTypedData_v4',
      params: [this.address, JSON.stringify(typedData)],
    })

    return {
      x402Version: 1,
      scheme: 'exact',
      network: requirement.network,
      payload: { signature, authorization },
    }
  }
}

async function ensureChain(provider: EthereumProvider, chainId: number): Promise<void> {
  const hex = `0x${chainId.toString(16)}`
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hex }],
    })
  } catch (err: any) {
    // Code 4902 = chain not added to wallet. The user can add it manually.
    if (err?.code === 4902) {
      throw new Error(`Chain ${chainId} not added to wallet — add it first`)
    }
    throw err
  }
}

function randomBytes32(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return (
    '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  )
}
