export type MemoryType = "fact" | "preference" | "event" | "system_rule"

export type Importance = 1 | 2 | 3 | 4 | 5

export interface MemoryRecord {
  id: string
  type: MemoryType
  content: string
  tags: string[]
  people: string[]
  projects: string[]
  importance: Importance
  supersedesId?: string
  confidence: number
  source: string
  createdAt: number
  accessCount: number
  lastAccessedAt: number
}

export interface ScoredMemoryRecord extends MemoryRecord {
  score: number
  similarity: number
}
