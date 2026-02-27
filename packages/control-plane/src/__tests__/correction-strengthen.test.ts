import { describe, expect, it, vi } from "vitest"

import type {
  EmbeddingFn,
  FeedbackEntry,
  RuleSynthesizer,
} from "@cortex/shared/correction-strengthener"

import {
  createCorrectionStrengthenTask,
  type CorrectionStrengthenDeps,
  type CorrectionStrengthenPayload,
  runCorrectionStrengthenPipeline,
} from "../worker/tasks/correction-strengthen.js"

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

function makeDeps(overrides: Partial<CorrectionStrengthenDeps> = {}): CorrectionStrengthenDeps {
  return {
    embed: vi.fn<EmbeddingFn>().mockResolvedValue([1, 0, 0]),
    synthesize: vi.fn<RuleSynthesizer>().mockResolvedValue("Always use snake_case"),
    ...overrides,
  }
}

function makePayload(
  overrides: Partial<CorrectionStrengthenPayload> = {},
): CorrectionStrengthenPayload {
  return {
    agentId: "agent-test",
    feedback: [makeEntry({ id: "fb-1" }), makeEntry({ id: "fb-2" }), makeEntry({ id: "fb-3" })],
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
  } as unknown as Parameters<ReturnType<typeof createCorrectionStrengthenTask>>[1]
}

// ──────────────────────────────────────────────────
// runCorrectionStrengthenPipeline
// ──────────────────────────────────────────────────

describe("runCorrectionStrengthenPipeline", () => {
  it("runs the full pipeline and returns result", async () => {
    const deps = makeDeps()
    const feedback = [
      makeEntry({ id: "fb-1" }),
      makeEntry({ id: "fb-2" }),
      makeEntry({ id: "fb-3" }),
    ]

    const result = await runCorrectionStrengthenPipeline("agent-1", feedback, deps)

    expect(result.totalFeedback).toBe(3)
    expect(result.proposals.length).toBeGreaterThanOrEqual(1)
    expect(deps.embed).toHaveBeenCalledTimes(3)
    expect(deps.synthesize).toHaveBeenCalled()
  })

  it("returns empty proposals when no clusters qualify", async () => {
    // Each entry gets a different embedding → no cluster
    let idx = 0
    const embed = vi.fn<EmbeddingFn>().mockImplementation(async () => {
      const v = [0, 0, 0]
      v[idx % 3] = 1
      idx++
      return v
    })
    const deps = makeDeps({ embed })
    const feedback = [
      makeEntry({ id: "fb-1" }),
      makeEntry({ id: "fb-2" }),
      makeEntry({ id: "fb-3" }),
    ]

    const result = await runCorrectionStrengthenPipeline("agent-1", feedback, deps)

    expect(result.proposals).toHaveLength(0)
    expect(result.clustersAboveThreshold).toBe(0)
  })

  it("passes config through to the pipeline", async () => {
    const deps = makeDeps()
    const feedback = [makeEntry(), makeEntry(), makeEntry()]

    const result = await runCorrectionStrengthenPipeline("agent-1", feedback, deps, {
      minClusterSize: 5, // higher threshold than entries
    })

    expect(result.proposals).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────
// createCorrectionStrengthenTask
// ──────────────────────────────────────────────────

describe("createCorrectionStrengthenTask", () => {
  it("runs as no-op when no deps provided", async () => {
    const task = createCorrectionStrengthenTask()
    const helpers = mockHelpers()

    await task(makePayload(), helpers)

    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("no deps configured"))
  })

  it("runs as no-op for empty feedback", async () => {
    const deps = makeDeps()
    const task = createCorrectionStrengthenTask(deps)
    const helpers = mockHelpers()

    await task(makePayload({ feedback: [] }), helpers)

    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("no feedback entries"))
    expect(deps.embed).not.toHaveBeenCalled()
  })

  it("runs full pipeline with deps", async () => {
    const deps = makeDeps()
    const task = createCorrectionStrengthenTask(deps)
    const helpers = mockHelpers()

    await task(makePayload(), helpers)

    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("proposals="))
    expect(deps.embed).toHaveBeenCalled()
  })

  it("logs and rethrows on pipeline failure", async () => {
    const embed = vi.fn<EmbeddingFn>().mockRejectedValue(new Error("embed failed"))
    const deps = makeDeps({ embed })
    const task = createCorrectionStrengthenTask(deps)
    const helpers = mockHelpers()

    await expect(task(makePayload(), helpers)).rejects.toThrow("embed failed")
    expect(helpers.logger.error).toHaveBeenCalledWith(expect.stringContaining("embed failed"))
  })
})
