import { describe, expect, it, vi } from "vitest"

import { persistSignals } from "../proactive-detector/persist.js"
import type { Signal } from "../proactive-detector/types.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    source: "calendar",
    signalType: "event",
    title: "Test signal",
    summary: "A test signal for unit testing",
    confidence: 0.7,
    severity: "medium",
    opportunity: false,
    ...overrides,
  }
}

function mockStore(insertResult: string | null = "signal-123") {
  return {
    insertSignalIfNew: vi.fn().mockResolvedValue(insertResult),
    createSuggestion: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue(undefined),
  }
}

// ──────────────────────────────────────────────────
// persistSignals
// ──────────────────────────────────────────────────

describe("persistSignals", () => {
  it("persists signals above min confidence", async () => {
    const store = mockStore()
    const signals = [makeSignal({ confidence: 0.7 }), makeSignal({ confidence: 0.3 })]

    const result = await persistSignals(signals, store, { minConfidence: 0.5 })

    expect(result.persisted).toBe(1)
    expect(store.insertSignalIfNew).toHaveBeenCalledOnce()
    expect(store.createSuggestion).toHaveBeenCalledOnce()
  })

  it("skips signals below min confidence", async () => {
    const store = mockStore()
    const signals = [makeSignal({ confidence: 0.3 })]

    const result = await persistSignals(signals, store, { minConfidence: 0.5 })

    expect(result.persisted).toBe(0)
    expect(store.insertSignalIfNew).not.toHaveBeenCalled()
  })

  it("uses default min confidence of 0.5", async () => {
    const store = mockStore()
    const signals = [makeSignal({ confidence: 0.5 }), makeSignal({ confidence: 0.49 })]

    const result = await persistSignals(signals, store)

    expect(result.persisted).toBe(1)
  })

  it("skips duplicate fingerprints", async () => {
    const store = mockStore(null) // null = duplicate detected
    const signals = [makeSignal({ confidence: 0.7 })]

    const result = await persistSignals(signals, store)

    expect(result.persisted).toBe(0)
    expect(store.insertSignalIfNew).toHaveBeenCalledOnce()
    expect(store.createSuggestion).not.toHaveBeenCalled()
  })

  it("creates tasks for high-confidence signals when enabled", async () => {
    const store = mockStore()
    const signals = [makeSignal({ confidence: 0.9, severity: "high" })]

    const result = await persistSignals(signals, store, {
      createTasks: true,
      taskCreationThreshold: 0.82,
    })

    expect(result.persisted).toBe(1)
    expect(result.tasksCreated).toBe(1)
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("Proactive:") as string,
        priority: 2, // high severity → priority 2
        signalId: "signal-123",
      }),
    )
  })

  it("does not create tasks when disabled", async () => {
    const store = mockStore()
    const signals = [makeSignal({ confidence: 0.95 })]

    const result = await persistSignals(signals, store, { createTasks: false })

    expect(result.tasksCreated).toBe(0)
    expect(store.createTask).not.toHaveBeenCalled()
  })

  it("does not create tasks below taskCreationThreshold", async () => {
    const store = mockStore()
    const signals = [makeSignal({ confidence: 0.75 })]

    const result = await persistSignals(signals, store, {
      createTasks: true,
      taskCreationThreshold: 0.82,
    })

    expect(result.tasksCreated).toBe(0)
  })

  it("maps severity to priority correctly", async () => {
    const store = mockStore()

    await persistSignals([makeSignal({ confidence: 0.9, severity: "critical" })], store, {
      createTasks: true,
    })
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({ priority: 1 }))

    await persistSignals([makeSignal({ confidence: 0.9, severity: "high" })], store, {
      createTasks: true,
    })
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({ priority: 2 }))

    await persistSignals([makeSignal({ confidence: 0.9, severity: "medium" })], store, {
      createTasks: true,
    })
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({ priority: 3 }))
  })

  it("handles empty signals list", async () => {
    const store = mockStore()
    const result = await persistSignals([], store)

    expect(result.persisted).toBe(0)
    expect(result.tasksCreated).toBe(0)
  })
})
