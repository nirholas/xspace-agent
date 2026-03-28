// =============================================================================
// Memory & RAG — Public API
// =============================================================================

export { MemoryStore } from './store'
export { KnowledgeBase } from './knowledge-base'
export { MemoryExtractor } from './extraction'
export { ContextRetriever } from './retrieval'
export { EmbeddingClient, cosineSimilarity, searchBySimilarity } from './embeddings'

export type {
  Memory,
  MemoryType,
  UserProfile,
  MemoryConfig,
  KnowledgeConfig,
  DocumentChunk,
  IndexedDocument,
  RetrievalResult,
} from './types'
