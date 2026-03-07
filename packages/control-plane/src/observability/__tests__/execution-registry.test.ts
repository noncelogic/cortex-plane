import type { ExecutionHandle, ExecutionResult, OutputEvent } from "@cortex/shared/backends"
import { describe, expect, it, vi } from "vitest"

import { ExecutionRegistry } from "../execution-registry.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockHandle(taskId = "task-1"): ExecutionHandle & { _cancelReason?: string } {
  let cancelReason: string | undefined
  return {
    taskId,

    async *events(): AsyncGenerator<OutputEvent> {
      /* no events */
    },
    async result(): Promise<ExecutionResult> {
      return {
        taskId,
        status: "completed",
        exitCode: 0,
        summary: "done",
        fileChanges: [],
        stdout: "",
        stderr: "",
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        artifacts: [],
        durationMs: 100,
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async cancel(reason: string) {
      cancelReason = reason
    },
    get _cancelReason() {
      return cancelReason
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExecutionRegistry", () => {
  it("registers and retrieves running job IDs", () => {
    const registry = new ExecutionRegistry()
    const handle1 = createMockHandle("t1")
    const handle2 = createMockHandle("t2")

    registry.register("job-1", handle1)
    registry.register("job-2", handle2)

    expect(registry.getRunningJobIds()).toEqual(expect.arrayContaining(["job-1", "job-2"]))
    expect(registry.size).toBe(2)
  })

  it("unregisters a job handle", () => {
    const registry = new ExecutionRegistry()
    registry.register("job-1", createMockHandle())

    registry.unregister("job-1")

    expect(registry.getRunningJobIds()).toEqual([])
    expect(registry.size).toBe(0)
  })

  it("cancels a registered job and returns true", async () => {
    const registry = new ExecutionRegistry()
    const handle = createMockHandle()
    registry.register("job-1", handle)

    const result = await registry.cancel("job-1", "operator_kill")

    expect(result).toBe(true)
    expect(handle._cancelReason).toBe("operator_kill")
  })

  it("returns false when cancelling an unregistered job", async () => {
    const registry = new ExecutionRegistry()

    const result = await registry.cancel("nonexistent", "kill")

    expect(result).toBe(false)
  })

  it("overwrites handle when registering the same jobId twice", () => {
    const registry = new ExecutionRegistry()
    const handle1 = createMockHandle("t1")
    const handle2 = createMockHandle("t2")

    registry.register("job-1", handle1)
    registry.register("job-1", handle2)

    expect(registry.size).toBe(1)
  })

  it("cancel invokes handle.cancel with the reason", async () => {
    const registry = new ExecutionRegistry()
    const handle = createMockHandle()
    const cancelSpy = vi.spyOn(handle, "cancel")
    registry.register("job-1", handle)

    await registry.cancel("job-1", "cost_budget_exceeded")

    expect(cancelSpy).toHaveBeenCalledWith("cost_budget_exceeded")
  })

  it("getRunningJobIds returns empty array when no jobs registered", () => {
    const registry = new ExecutionRegistry()
    expect(registry.getRunningJobIds()).toEqual([])
  })
})
