export { VoiceChat } from './VoiceChat';
export { useVoiceChat } from './useVoiceChat';
export { AudioVisualizer } from './AudioVisualizer';
export type {
  VoiceChatProps,
  UseVoiceChatOptions,
  UseVoiceChatReturn,
  AudioVisualizerProps,
} from './types';

// Re-export core types for convenience
export type { Message, ClientConfig, ConnectionState } from '@agent-voice-chat/core';
