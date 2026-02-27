import type { Signal, SignalCollector, SignalPersistence } from "@cortex/shared/proactive-detector"
import { describe, expect, it, vi } from "vitest"

import {
  createProactiveDetectTask,
  type ProactiveDetectDeps,
  type ProactiveDetectPayload,
  runProactiveDetectPipeline,
} from "../worker/tasks/proactive-detect.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    source: "calendar",
    signalType: "event",
    title: "Sprint planning meeting",
    summary: "Weekly sprint planning session",
    confidence: 0.7,
    severity: "medium",
    opportunity: false,
    ...overrides,
  }
}

function makeCollector(signals: Signal[]): SignalCollector {
  return {
    source: signals[0]?.source ?? "calendar",
    collect: vi.fn().mockResolvedValue(signals),
  }
}

function mockStore(insertResult: string | null = "signal-123"): SignalPersistence {
  return {
    insertSignalIfNew: vi.fn().mockResolvedValue(insertResult),
    createSuggestion: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue(undefined),
  }
}

function makeDeps(overrides: Partial<ProactiveDetectDeps> = {}): ProactiveDetectDeps {
  return {
    collectors: [makeCollector([makeSignal()])],
    store: mockStore(),
    ...overrides,
  }
}

function makePayload(overrides: Partial<ProactiveDetectPayload> = {}): ProactiveDetectPayload {
  return {
    agentId: "agent-test",
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
  } as unknown as Parameters<ReturnType<typeof createProactiveDetectTask>>[1]
}

// ──────────────────────────────────────────────────
// runProactiveDetectPipeline
// ──────────────────────────────────────────────────

describe("runProactiveDetectPipeline", () => {
  it("collects and persists signals", async () => {
    const store = mockStore()
    const deps = makeDeps({ store })

    const result = await runProactiveDetectPipeline("agent-1", deps)

    expect(result.signalsCollected).toBe(1)
    expect(result.persisted).toBe(1)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(store.insertSignalIfNew).toHaveBeenCalled()
  })

  it("generates cross-signals from calendar + email", async () => {
    const store = mockStore()
    const deps = makeDeps({
      store,
      collectors: [
        makeCollector([
          makeSignal({
            source: "calendar",
            title: "Sprint planning review",
            summary: "Discuss sprint backlog items and review",
          }),
        ]),
        makeCollector([
          makeSignal({
            source: "email",
            title: "Sprint planning preparation",
            summary: "Please prepare for sprint planning review backlog",
          }),
        ]),
      ],
    })

    const result = await runProactiveDetectPipeline("agent-1", deps)

    expect(result.signalsCollected).toBe(2)
    expect(result.crossSignals).toBeGreaterThanOrEqual(1)
  })

  it("handles empty collectors", async () => {
    const store = mockStore()
    const deps = makeDeps({
      store,
      collectors: [makeCollector([])],
    })

    const result = await runProactiveDetectPipeline("agent-1", deps)

    expect(result.signalsCollected).toBe(0)
    expect(result.persisted).toBe(0)
  })

  it("passes config through", async () => {
    const store = mockStore()
    const deps = makeDeps({ store })

    const result = await runProactiveDetectPipeline("agent-1", deps, {
      minConfidence: 0.9, // above the default signal confidence
    })

    expect(result.persisted).toBe(0) // signal at 0.7 < 0.9 threshold
  })
})

// ──────────────────────────────────────────────────
// createProactiveDetectTask
// ──────────────────────────────────────────────────

describe("createProactiveDetectTask", () => {
  it("runs as no-op when no deps provided", async () => {
    const task = createProactiveDetectTask()
    const helpers = mockHelpers()

    await task(makePayload(), helpers)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("no deps configured"))
  })

  it("runs as no-op for empty collectors", async () => {
    const deps = makeDeps({ collectors: [] })
    const task = createProactiveDetectTask(deps)
    const helpers = mockHelpers()

    await task(makePayload(), helpers)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(helpers.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("no collectors registered"),
    )
  })

  it("runs full pipeline with deps", async () => {
    const deps = makeDeps()
    const task = createProactiveDetectTask(deps)
    const helpers = mockHelpers()

    await task(makePayload(), helpers)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(helpers.logger.info).toHaveBeenCalledWith(expect.stringContaining("collected="))
  })

  it("logs and rethrows on pipeline failure", async () => {
    const failingCollector: SignalCollector = {
      source: "calendar",
      collect: vi.fn().mockRejectedValue(new Error("API unavailable")),
    }
    const deps = makeDeps({ collectors: [failingCollector] })
    const task = createProactiveDetectTask(deps)
    const helpers = mockHelpers()

    await expect(task(makePayload(), helpers)).rejects.toThrow("API unavailable")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(helpers.logger.error).toHaveBeenCalledWith(expect.stringContaining("API unavailable"))
  })
})
