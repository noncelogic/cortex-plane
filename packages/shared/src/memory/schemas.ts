import { z } from "zod"

// ──────────────────────────────────────────────────
// Atomic fact types — extends existing MemoryType with
// extraction-specific types (lesson, relationship)
// ──────────────────────────────────────────────────

export const AtomicFactTypeSchema = z.enum([
  "fact",
  "preference",
  "event",
  "system_rule",
  "lesson",
  "relationship",
])

export type AtomicFactType = z.infer<typeof AtomicFactTypeSchema>

// ──────────────────────────────────────────────────
// Source provenance
// ──────────────────────────────────────────────────

export const SourceSchema = z.object({
  sessionId: z.string(),
  turnIndex: z.number().int(),
  timestamp: z.string(),
})

export type Source = z.infer<typeof SourceSchema>

// ──────────────────────────────────────────────────
// Atomic fact — the core extracted memory unit
// ──────────────────────────────────────────────────

export const AtomicFactSchema = z.object({
  content: z.string().min(10).max(2000),
  type: AtomicFactTypeSchema,
  confidence: z.number().min(0).max(1),
  importance: z.number().int().min(1).max(5),
  tags: z.array(z.string()).max(10),
  people: z.array(z.string()).max(10),
  projects: z.array(z.string()).max(10),
  source: SourceSchema,
  supersedes: z.array(z.string()).optional(),
})

export type AtomicFact = z.infer<typeof AtomicFactSchema>

// ──────────────────────────────────────────────────
// Extraction response — the full LLM output envelope
// ──────────────────────────────────────────────────

export const ExtractionResponseSchema = z.object({
  facts: z.array(AtomicFactSchema),
})

export type ExtractionResponse = z.infer<typeof ExtractionResponseSchema>

// ──────────────────────────────────────────────────
// Extraction summary — pipeline result metrics
// ──────────────────────────────────────────────────

export interface ExtractionSummary {
  extracted: number
  deduped: number
  superseded: number
  failed: number
}
