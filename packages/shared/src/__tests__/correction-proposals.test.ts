import { describe, expect, it, vi } from "vitest"

import { buildProposals, inferTargetFile } from "../correction-strengthener/proposals.js"
import type { FeedbackEntry, RuleSynthesizer } from "../correction-strengthener/types.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id: `fb-${Math.random().toString(36).slice(2, 8)}`,
    content: "Always use snake_case for variable naming",
    agentId: "agent-test",
    sessionId: "sess-001",
    timestamp: "2025-01-15T10:00:00Z",
    ...overrides,
  }
}

const mockSynthesize: RuleSynthesizer = vi.fn((entries: FeedbackEntry[]) => {
  return Promise.resolve(`Rule: ${entries[0]!.content}`)
})

// ──────────────────────────────────────────────────
// inferTargetFile
// ──────────────────────────────────────────────────

describe("inferTargetFile", () => {
  it("returns null when no entries have targetFile", () => {
    const entries = [makeEntry(), makeEntry(), makeEntry()]
    expect(inferTargetFile(entries)).toBeNull()
  })

  it("returns the only target file when all agree", () => {
    const entries = [
      makeEntry({ targetFile: "IDENTITY.md" }),
      makeEntry({ targetFile: "IDENTITY.md" }),
      makeEntry({ targetFile: "IDENTITY.md" }),
    ]
    expect(inferTargetFile(entries)).toBe("IDENTITY.md")
  })

  it("returns majority vote file", () => {
    const entries = [
      makeEntry({ targetFile: "IDENTITY.md" }),
      makeEntry({ targetFile: "IDENTITY.md" }),
      makeEntry({ targetFile: "SKILL.md" }),
    ]
    expect(inferTargetFile(entries)).toBe("IDENTITY.md")
  })

  it("handles mixed entries with and without targetFile", () => {
    const entries = [
      makeEntry({ targetFile: "config.yaml" }),
      makeEntry(),
      makeEntry({ targetFile: "config.yaml" }),
      makeEntry(),
    ]
    expect(inferTargetFile(entries)).toBe("config.yaml")
  })

  it("handles empty entries array", () => {
    expect(inferTargetFile([])).toBeNull()
  })
})

// ──────────────────────────────────────────────────
// buildProposals
// ──────────────────────────────────────────────────

describe("buildProposals", () => {
  it("returns proposals for qualifying clusters", async () => {
    const entries = [
      makeEntry({ id: "fb-1", content: "Use snake_case" }),
      makeEntry({ id: "fb-2", content: "Use snake_case" }),
      makeEntry({ id: "fb-3", content: "Use snake_case" }),
    ]
    // All identical embeddings → one big cluster
    const v = [1, 0, 0]
    const embeddings = [v, v, v]

    const proposals = await buildProposals(entries, embeddings, mockSynthesize)

    expect(proposals).toHaveLength(1)
    expect(proposals[0]!.clusterSize).toBe(3)
    expect(proposals[0]!.supportingFeedbackIds).toEqual(["fb-1", "fb-2", "fb-3"])
    expect(proposals[0]!.confidence).toBeGreaterThan(0.9)
    expect(mockSynthesize).toHaveBeenCalledOnce()
  })

  it("returns empty when no clusters meet threshold", async () => {
    const entries = [makeEntry({ id: "fb-1" }), makeEntry({ id: "fb-2" })]
    const embeddings = [
      [1, 0, 0],
      [1, 0, 0],
    ]

    // minClusterSize defaults to 3, only 2 entries
    const proposals = await buildProposals(entries, embeddings, mockSynthesize)
    expect(proposals).toHaveLength(0)
  })

  it("uses custom similarity threshold", async () => {
    const entries = Array.from({ length: 3 }, (_, i) => makeEntry({ id: `fb-${i}` }))
    // Semi-similar embeddings
    const embeddings = [
      [1, 0.3, 0],
      [1, 0.2, 0],
      [1, 0.4, 0],
    ]

    // Loose threshold: should cluster
    const loose = await buildProposals(entries, embeddings, mockSynthesize, {
      similarityThreshold: 0.9,
    })
    expect(loose.length).toBeGreaterThanOrEqual(1)

    // Tight threshold: may not cluster
    const tight = await buildProposals(entries, embeddings, mockSynthesize, {
      similarityThreshold: 0.999,
    })
    expect(tight.length).toBeLessThanOrEqual(loose.length)
  })

  it("sorts proposals by cluster size then confidence", async () => {
    const entries = [
      // Group A: 4 entries
      ...Array.from({ length: 4 }, (_, i) =>
        makeEntry({ id: `a-${i}`, content: "Group A feedback" }),
      ),
      // Group B: 3 entries
      ...Array.from({ length: 3 }, (_, i) =>
        makeEntry({ id: `b-${i}`, content: "Group B feedback" }),
      ),
    ]

    const v1 = [1, 0, 0]
    const v2 = [0, 1, 0]
    const embeddings = [
      ...Array.from({ length: 4 }, () => v1),
      ...Array.from({ length: 3 }, () => v2),
    ]

    const proposals = await buildProposals(entries, embeddings, mockSynthesize)
    expect(proposals).toHaveLength(2)
    expect(proposals[0]!.clusterSize).toBe(4) // larger first
    expect(proposals[1]!.clusterSize).toBe(3)
  })

  it("includes target file from cluster entries", async () => {
    const entries = [
      makeEntry({ id: "fb-1", targetFile: "MEMORY.md" }),
      makeEntry({ id: "fb-2", targetFile: "MEMORY.md" }),
      makeEntry({ id: "fb-3", targetFile: "MEMORY.md" }),
    ]
    const v = [1, 0, 0]
    const embeddings = [v, v, v]

    const proposals = await buildProposals(entries, embeddings, mockSynthesize)
    expect(proposals[0]!.targetFile).toBe("MEMORY.md")
  })

  it("calls synthesizer with cluster entries", async () => {
    const synth = vi.fn<RuleSynthesizer>().mockResolvedValue("Do X always")
    const entries = [
      makeEntry({ id: "fb-1", content: "Feedback A" }),
      makeEntry({ id: "fb-2", content: "Feedback A" }),
      makeEntry({ id: "fb-3", content: "Feedback A" }),
    ]
    const v = [1, 0, 0]
    const embeddings = [v, v, v]

    const proposals = await buildProposals(entries, embeddings, synth)
    expect(proposals[0]!.proposedRule).toBe("Do X always")
    expect(synth).toHaveBeenCalledWith(entries)
  })
})
