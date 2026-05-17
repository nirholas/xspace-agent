// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'

import type {
  Network,
  PaymentPayload,
  PaymentRequirement,
  WalletAdapter,
} from '../types'

// Minimal shape of the Phantom-injected provider.
interface PhantomProvider {
  isPhantom?: boolean
  publicKey: { toString(): string } | null
  connect(): Promise<{ publicKey: { toString(): string } }>
  disconnect(): Promise<void>
  signTransaction(tx: Transaction): Promise<Transaction>
}

declare global {
  interface Window {
    solana?: PhantomProvider
    phantom?: { solana?: PhantomProvider }
  }
}

function getProvider(): PhantomProvider | null {
  if (typeof window === 'undefined') return null
  const direct = window.solana
  if (direct?.isPhantom) return direct
  const fromPhantom = window.phantom?.solana
  if (fromPhantom?.isPhantom) return fromPhantom
  return null
}

export class PhantomAdapter implements WalletAdapter {
  readonly kind = 'phantom' as const

  private address: string | null = null
  private readonly rpcUrl: string

  constructor(opts: { rpcUrl?: string } = {}) {
    this.rpcUrl = opts.rpcUrl ?? 'https://api.mainnet-beta.solana.com'
  }

  supports(network: Network): boolean {
    return network === 'solana' || network === 'solana-devnet'
  }

  isAvailable(): boolean {
    return getProvider() !== null
  }

  async connect(): Promise<{ address: string }> {
    const provider = getProvider()
    if (!provider) throw new Error('Phantom wallet not detected')
    const { publicKey } = await provider.connect()
    this.address = publicKey.toString()
    return { address: this.address }
  }

  async disconnect(): Promise<void> {
    const provider = getProvider()
    await provider?.disconnect().catch(() => undefined)
    this.address = null
  }

  getAddress(): string | null {
    return this.address
  }

  async buildPaymentPayload(requirement: PaymentRequirement): Promise<PaymentPayload> {
    if (!this.supports(requirement.network)) {
      throw new Error(`PhantomAdapter does not support network ${requirement.network}`)
    }
    const provider = getProvider()
    if (!provider) throw new Error('Phantom wallet not available')
    if (!this.address) await this.connect()
    if (!this.address) throw new Error('Phantom connect did not return an address')

    const connection = new Connection(this.rpcUrl, 'confirmed')
    const payer = new PublicKey(this.address)
    const recipientMain = new PublicKey(requirement.payTo)
    const mint = new PublicKey(requirement.asset)

    const decimals = (requirement.extra?.decimals as number | undefined) ?? 6
    const amount = BigInt(requirement.maxAmountRequired)

    const payerAta = await getAssociatedTokenAddress(mint, payer)
    const recipientAta = await getAssociatedTokenAddress(mint, recipientMain)

    const instructions: TransactionInstruction[] = []

    // If the recipient's ATA doesn't exist yet, create it (payer funds the rent).
    const recipientAtaInfo = await connection.getAccountInfo(recipientAta)
    if (!recipientAtaInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(payer, recipientAta, recipientMain, mint),
      )
    }

    instructions.push(
      createTransferCheckedInstruction(
        payerAta,
        mint,
        recipientAta,
        payer,
        amount,
        decimals,
        [],
        TOKEN_PROGRAM_ID,
      ),
    )

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight })
    tx.add(...instructions)

    const signed = await provider.signTransaction(tx)
    const serialized = signed.serialize({ requireAllSignatures: false }).toString('base64')

    return {
      x402Version: 1,
      scheme: 'exact',
      network: requirement.network,
      payload: { transaction: serialized },
    }
  }
}
