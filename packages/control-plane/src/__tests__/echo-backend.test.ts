import { describe, expect, it } from "vitest"

import type { ExecutionTask, OutputEvent } from "@cortex/shared"

import { EchoBackend } from "../backends/echo-backend.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function makeTask(overrides?: Partial<ExecutionTask>): ExecutionTask {
  return {
    id: "task-echo-001",
    jobId: "job-echo-001",
    agentId: "agent-echo-001",
    instruction: {
      prompt: "Hello from echo test",
      goalType: "code_edit",
    },
    context: {
      workspacePath: "/workspace",
      systemPrompt: "",
      memories: [],
      relevantFiles: {},
      environment: {},
    },
    constraints: {
      timeoutMs: 60_000,
      maxTokens: 200_000,
      model: "echo",
      allowedTools: [],
      deniedTools: [],
      maxTurns: 1,
      networkAccess: false,
      shellAccess: false,
    },
    ...overrides,
  }
}

async function collectEvents(handle: { events(): AsyncIterable<OutputEvent> }): Promise<OutputEvent[]> {
  const events: OutputEvent[] = []
  for await (const event of handle.events()) {
    events.push(event)
  }
  return events
}

// ──────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────

describe("EchoBackend — lifecycle", () => {
  it("has backendId 'echo'", () => {
    const backend = new EchoBackend()
    expect(backend.backendId).toBe("echo")
  })

  it("starts successfully", async () => {
    const backend = new EchoBackend()
    await backend.start({})
    // Should not throw
  })

  it("stops successfully", async () => {
    const backend = new EchoBackend()
    await backend.start({})
    await backend.stop()
    // Should not throw
  })

  it("reads latencyMs from config", async () => {
    const backend = new EchoBackend()
    await backend.start({ latencyMs: 100 })

    const health = await backend.healthCheck()
    expect(health.details).toHaveProperty("latencyMs", 100)
  })

  it("reads failureRate from config", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 0.5 })

    const health = await backend.healthCheck()
    expect(health.details).toHaveProperty("failureRate", 0.5)
  })

  it("clamps failureRate to [0, 1]", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 2.0 })

    const health = await backend.healthCheck()
    expect(health.details).toHaveProperty("failureRate", 1.0)
  })
})

// ──────────────────────────────────────────────────
// Health Check
// ──────────────────────────────────────────────────

describe("EchoBackend — healthCheck()", () => {
  it("returns healthy when started", async () => {
    const backend = new EchoBackend()
    await backend.start({})

    const report = await backend.healthCheck()
    expect(report.status).toBe("healthy")
    expect(report.backendId).toBe("echo")
  })

  it("returns unhealthy when not started", async () => {
    const backend = new EchoBackend()

    const report = await backend.healthCheck()
    expect(report.status).toBe("unhealthy")
  })

  it("returns unhealthy after stop", async () => {
    const backend = new EchoBackend()
    await backend.start({})
    await backend.stop()

    const report = await backend.healthCheck()
    expect(report.status).toBe("unhealthy")
  })
})

// ──────────────────────────────────────────────────
// Capabilities
// ──────────────────────────────────────────────────

describe("EchoBackend — getCapabilities()", () => {
  it("returns echo capabilities", () => {
    const backend = new EchoBackend()
    const caps = backend.getCapabilities()

    expect(caps.supportsStreaming).toBe(false)
    expect(caps.supportsFileEdit).toBe(false)
    expect(caps.supportsCancellation).toBe(true)
    expect(caps.supportedGoalTypes).toContain("code_edit")
    expect(caps.supportedGoalTypes).toContain("research")
  })
})

// ──────────────────────────────────────────────────
// Execution — Success Path
// ──────────────────────────────────────────────────

describe("EchoBackend — execution (success)", () => {
  it("echoes the prompt as text event", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 0 })

    const task = makeTask({ instruction: { prompt: "Say hello", goalType: "code_edit" } })
    const handle = await backend.executeTask(task)
    const events = await collectEvents(handle)

    const textEvents = events.filter((e) => e.type === "text")
    expect(textEvents).toHaveLength(1)
    expect(textEvents[0]!.type === "text" && textEvents[0]!.content).toBe("Say hello")
  })

  it("emits complete event with success result", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 0 })

    const handle = await backend.executeTask(makeTask())
    const events = await collectEvents(handle)

    const completeEvents = events.filter((e) => e.type === "complete")
    expect(completeEvents).toHaveLength(1)

    const result = await handle.result()
    expect(result.status).toBe("completed")
    expect(result.exitCode).toBe(0)
    expect(result.summary).toBe("Hello from echo test")
  })

  it("returns prompt as stdout", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 0 })

    const handle = await backend.executeTask(makeTask())
    await collectEvents(handle)

    const result = await handle.result()
    expect(result.stdout).toBe("Hello from echo test")
  })

  it("reports zero token usage", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 0 })

    const handle = await backend.executeTask(makeTask())
    await collectEvents(handle)

    const result = await handle.result()
    expect(result.tokenUsage.inputTokens).toBe(0)
    expect(result.tokenUsage.outputTokens).toBe(0)
  })

  it("returns empty file changes", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 0 })

    const handle = await backend.executeTask(makeTask())
    await collectEvents(handle)

    const result = await handle.result()
    expect(result.fileChanges).toEqual([])
  })
})

// ──────────────────────────────────────────────────
// Execution — Failure Path
// ──────────────────────────────────────────────────

describe("EchoBackend — execution (failure)", () => {
  it("fails with configured classification", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 1.0, failureClassification: "transient" })

    const handle = await backend.executeTask(makeTask())
    await collectEvents(handle)

    const result = await handle.result()
    expect(result.status).toBe("failed")
    expect(result.error).toBeDefined()
    expect(result.error!.classification).toBe("transient")
    expect(result.error!.message).toContain("simulated failure")
  })

  it("emits complete event on failure", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 1.0 })

    const handle = await backend.executeTask(makeTask())
    const events = await collectEvents(handle)

    const completeEvents = events.filter((e) => e.type === "complete")
    expect(completeEvents).toHaveLength(1)
  })

  it("uses permanent classification when configured", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 1.0, failureClassification: "permanent" })

    const handle = await backend.executeTask(makeTask())
    await collectEvents(handle)

    const result = await handle.result()
    expect(result.error!.classification).toBe("permanent")
  })
})

// ──────────────────────────────────────────────────
// Cancellation
// ──────────────────────────────────────────────────

describe("EchoBackend — cancellation", () => {
  it("cancels and returns cancelled result", async () => {
    const backend = new EchoBackend()
    await backend.start({ latencyMs: 10_000 })

    const handle = await backend.executeTask(makeTask())

    // Cancel immediately before events can complete
    await handle.cancel("Test cancellation")

    const result = await handle.result()
    expect(result.status).toBe("cancelled")
    expect(result.summary).toContain("Test cancellation")
  })
})

// ──────────────────────────────────────────────────
// configure()
// ──────────────────────────────────────────────────

describe("EchoBackend — configure()", () => {
  it("updates failure rate at runtime", async () => {
    const backend = new EchoBackend()
    await backend.start({ failureRate: 0 })

    backend.configure({ failureRate: 1.0 })

    const handle = await backend.executeTask(makeTask())
    await collectEvents(handle)

    const result = await handle.result()
    expect(result.status).toBe("failed")
  })

  it("updates latency at runtime", async () => {
    const backend = new EchoBackend()
    await backend.start({})

    backend.configure({ latencyMs: 50 })

    const start = Date.now()
    const handle = await backend.executeTask(makeTask())
    await collectEvents(handle)
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(40)
  })
})

// ──────────────────────────────────────────────────
// Error on not started
// ──────────────────────────────────────────────────

describe("EchoBackend — not started", () => {
  it("throws when executeTask called without start", async () => {
    const backend = new EchoBackend()
    await expect(backend.executeTask(makeTask())).rejects.toThrow("not started")
  })
})
