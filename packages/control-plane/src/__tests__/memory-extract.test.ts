import type { MemoryStore } from "@cortex/shared/memory"
import type { MemoryRecord, ScoredMemoryRecord } from "@cortex/shared/memory"
import { describe, expect, it, vi } from "vitest"

import {
  createMemoryExtractTask,
  type EmbeddingFn,
  type LLMCaller,
  type MemoryExtractDeps,
  type MemoryExtractPayload,
  parseExtractionResponse,
  runExtractionPipeline,
} from "../worker/tasks/memory-extract.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function validLLMResponse(facts: Record<string, unknown>[] = []): string {
  if (facts.length === 0) {
    facts = [
      {
        content: "The API uses REST with JSON payloads for all endpoints",
        type: "fact",
        confidence: 0.9,
        importance: 3,
        tags: ["api", "rest"],
        people: [],
        projects: ["cortex"],
        source: {
          sessionId: "sess-001",
          turnIndex: 3,
          timestamp: "2025-01-15T10:30:00Z",
        },
        supersedes: [],
      },
    ]
  }
  return JSON.stringify({ facts })
}

function mockStore(
  searchResults: ScoredMemoryRecord[] = [],
  getByIdResult: MemoryRecord | null = null,
): MemoryStore {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(searchResults),
    getById: vi.fn().mockResolvedValue(getByIdResult),
    delete: vi.fn().mockResolvedValue(undefined),
  }
}

const mockEmbed: EmbeddingFn = () =>
  Promise.resolve(Array.from({ length: 1536 }, () => Math.random()))

function makeDeps(overrides: Partial<MemoryExtractDeps> = {}): MemoryExtractDeps {
  return {
    memoryStore: mockStore(),
    llmCall: vi.fn<LLMCaller>().mockResolvedValue(validLLMResponse()),
    embed: mockEmbed,
    ...overrides,
  }
}

function makePayload(overrides: Partial<MemoryExtractPayload> = {}): MemoryExtractPayload {
  return {
    sessionId: "sess-001",
    agentId: "agent-test",
    messages: [
      { role: "user", content: "How does the API work?", timestamp: "2025-01-15T10:29:00Z" },
      {
        role: "assistant",
        content: "The API uses REST with JSON payloads.",
        timestamp: "2025-01-15T10:30:00Z",
      },
    ],
    ...overrides,
  }
}

function mockHelpers() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    addJob: vi.fn(),
    job: { id: "job-1" },
    withPgClient: vi.fn(),
  } as unknown as Parameters<ReturnType<typeof createMemoryExtractTask>>[1]
}

// ──────────────────────────────────────────────────
// parseExtractionResponse
// ──────────────────────────────────────────────────

describe("parseExtractionResponse", () => {
  it("parses valid JSON response", () => {
    const facts = parseExtractionResponse(validLLMResponse())
    expect(facts).toHaveLength(1)
    expect(facts[0]!.content).toContain("REST")
  })

  it("handles markdown-fenced JSON", () => {
    const fenced = "```json\n" + validLLMResponse() + "\n```"
    const facts = parseExtractionResponse(fenced)
    expect(facts).toHaveLength(1)
  })

  it("handles markdown-fenced without language specifier", () => {
    const fenced = "```\n" + validLLMResponse() + "\n```"
    const facts = parseExtractionResponse(fenced)
    expect(facts).toHaveLength(1)
  })

  it("throws on invalid JSON", () => {
    expect(() => parseExtractionResponse("not json")).toThrow()
  })

  it("throws on valid JSON but invalid schema", () => {
    expect(() => parseExtractionResponse('{"facts": [{"content": "short"}]}')).toThrow()
  })

  it("parses empty facts array", () => {
    const facts = parseExtractionResponse('{"facts": []}')
    expect(facts).toHaveLength(0)
  })

  it("parses multiple facts", () => {
    const multiFacts = [
      {
        content: "First fact is long enough to pass validation",
        type: "fact",
        confidence: 0.9,
        importance: 3,
        tags: [],
        people: [],
        projects: [],
        source: { sessionId: "s", turnIndex: 0, timestamp: "2025-01-15T10:00:00Z" },
      },
      {
        content: "Second fact is also long enough to pass validation",
        type: "preference",
        confidence: 0.8,
        importance: 2,
        tags: [],
        people: [],
        projects: [],
        source: { sessionId: "s", turnIndex: 1, timestamp: "2025-01-15T10:01:00Z" },
      },
    ]
    const facts = parseExtractionResponse(JSON.stringify({ facts: multiFacts }))
    expect(facts).toHaveLength(2)
  })
})

// ──────────────────────────────────────────────────
// runExtractionPipeline
// ──────────────────────────────────────────────────

describe("runExtractionPipeline", () => {
  it("runs the full pipeline and returns summary", async () => {
    const deps = makeDeps()
    const summary = await runExtractionPipeline("sess-001", "agent-1", makePayload().messages, deps)

    expect(summary.extracted).toBe(1)
    expect(summary.deduped).toBe(0)
    expect(summary.superseded).toBe(0)
    expect(summary.failed).toBe(0)
    expect(deps.llmCall).toHaveBeenCalledOnce()
  })

  it("calls embed for each extracted fact", async () => {
    const embed = vi.fn<EmbeddingFn>().mockResolvedValue(Array.from({ length: 1536 }, () => 0.01))
    const deps = makeDeps({ embed })

    await runExtractionPipeline("sess-001", "agent-1", makePayload().messages, deps)

    expect(embed).toHaveBeenCalledOnce()
  })

  it("counts deduped facts", async () => {
    const existing: ScoredMemoryRecord = {
      id: "existing-1",
      type: "fact",
      content: "Already known fact",
      tags: [],
      people: [],
      projects: [],
      importance: 3,
      confidence: 0.9,
      source: "session:s:0",
      createdAt: Date.now(),
      accessCount: 0,
      lastAccessedAt: Date.now(),
      score: 0.9,
      similarity: 0.95, // above dedup threshold
    }
    const store = mockStore([existing])
    const deps = makeDeps({ memoryStore: store })

    const summary = await runExtractionPipeline("sess-001", "agent-1", makePayload().messages, deps)

    expect(summary.extracted).toBe(1)
    expect(summary.deduped).toBe(1)
    expect(store.upsert).not.toHaveBeenCalled()
  })

  it("counts failed facts", async () => {
    const embed = vi.fn<EmbeddingFn>().mockRejectedValue(new Error("embed failed"))
    const deps = makeDeps({ embed })

    const summary = await runExtractionPipeline("sess-001", "agent-1", makePayload().messages, deps)

    expect(summary.extracted).toBe(1)
    expect(summary.failed).toBe(1)
  })

  it("handles empty LLM response", async () => {
    const llmCall = vi.fn<LLMCaller>().mockResolvedValue('{"facts": []}')
    const deps = makeDeps({ llmCall })

    const summary = await runExtractionPipeline("sess-001", "agent-1", makePayload().messages, deps)

    expect(summary.extracted).toBe(0)
    expect(summary.deduped).toBe(0)
    expect(summary.failed).toBe(0)
  })

  it("throws when LLM call fails", async () => {
    const llmCall = vi.fn<LLMCaller>().mockRejectedValue(new Error("LLM unavailable"))
    const deps = makeDeps({ llmCall })

    await expect(
      runExtractionPipeline("sess-001", "agent-1", makePayload().messages, deps),
    ).rejects.toThrow("LLM unavailable")
  })

  it("throws when LLM returns invalid JSON", async () => {
    const llmCall = vi.fn<LLMCaller>().mockResolvedValue("not json at all")
    const deps = makeDeps({ llmCall })

    await expect(
      runExtractionPipeline("sess-001", "agent-1", makePayload().messages, deps),
    ).rejects.toThrow()
  })
})

// ──────────────────────────────────────────────────
// createMemoryExtractTask
// ──────────────────────────────────────────────────

describe("createMemoryExtractTask", () => {
  it("runs as no-op when no deps provided", async () => {
    const task = createMemoryExtractTask()
    const helpers = mockHelpers()

    await task(makePayload(), helpers)

    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("no deps configured"))
  })

  it("runs as no-op for empty messages", async () => {
    const deps = makeDeps()
    const task = createMemoryExtractTask(deps)
    const helpers = mockHelpers()

    await task(makePayload({ messages: [] }), helpers)

    expect(helpers.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("no messages to extract"),
    )
    expect(deps.llmCall).not.toHaveBeenCalled()
  })

  it("runs full pipeline with deps", async () => {
    const deps = makeDeps()
    const task = createMemoryExtractTask(deps)
    const helpers = mockHelpers()

    await task(makePayload(), helpers)

    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("extracted=1"))
    expect(deps.llmCall).toHaveBeenCalledOnce()
  })

  it("logs and rethrows on pipeline failure", async () => {
    const llmCall = vi.fn<LLMCaller>().mockRejectedValue(new Error("boom"))
    const deps = makeDeps({ llmCall })
    const task = createMemoryExtractTask(deps)
    const helpers = mockHelpers()

    await expect(task(makePayload(), helpers)).rejects.toThrow("boom")
    expect(helpers.logger.error).toHaveBeenCalledWith(expect.stringContaining("boom"))
  })
})
