export type { QdrantMemoryClientOptions } from "./client.js"
export { QdrantMemoryClient } from "./client.js"
export { cosineSimilarity, isDuplicate, mergeMetadata, shouldSupersede } from "./dedup.js"
export { ensureCollection } from "./init.js"
export type {
  AtomicFact,
  AtomicFactType,
  ExtractionResponse,
  ExtractionSummary,
  Source,
} from "./schemas.js"
export {
  AtomicFactSchema,
  AtomicFactTypeSchema,
  ExtractionResponseSchema,
  SourceSchema,
} from "./schemas.js"
export { calculateDecay, calculateUtility, rankMemories, scoreMemory } from "./scoring.js"
export type { MemoryServiceOptions, MemoryStore, StoreOutcome, StoreResult } from "./service.js"
export { factToRecord, MemoryService } from "./service.js"
export type { Importance, MemoryRecord, MemoryType, ScoredMemoryRecord } from "./types.js"
