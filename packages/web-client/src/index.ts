// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas

export { XSpaceAskClient } from './client'
export type { XSpaceAskClientConfig, AskResult } from './client'

export { PhantomAdapter } from './wallet/phantom'
export { EvmAdapter } from './wallet/evm'

export { x402Fetch } from './x402-fetch'
export type { X402FetchResult, X402FetchOptions } from './x402-fetch'

export type {
  Network,
  WalletKind,
  WalletAdapter,
  PaymentPayload,
  PaymentRequirement,
  PaymentRequirementsResponse,
  AskResponseEvent,
  AskErrorEvent,
} from './types'
