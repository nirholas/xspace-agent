// =============================================================================
// Voice Cloning & Custom TTS — Public Exports
// =============================================================================

export { VoiceService } from './service'
export type { VoiceServiceConfig } from './service'
export { VoiceConsentManager } from './consent'
export { createElevenLabsCloningProvider } from './cloning-provider'
export type { VoiceCloningProvider } from './cloning-provider'
export type {
  AudioSample,
  Voice,
  VoiceConsent,
  VoiceCreateConfig,
  VoiceDesignParams,
  VoiceListingConfig,
  VoicePack,
  VoicePackEntry,
  VoicePreview,
  VoiceSettings,
} from './types'
