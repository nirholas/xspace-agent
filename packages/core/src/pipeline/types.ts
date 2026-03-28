// =============================================================================
// Pipeline – Provider Interfaces (re-exported from canonical types)
// =============================================================================

export type {
  LLMProvider,
  STTProvider,
  TTSProvider,
  CustomProvider,
  ProviderMetrics,
} from '../types'

/** @deprecated Use CustomProvider from '../types' instead. */
export type { CustomProvider as CustomProviderInterface } from '../types'
