/**
 * Echo Backend
 *
 * Lightweight stub backend for testing failover and circuit breaker
 * behavior without making real API calls. Returns the task prompt
 * as the result with configurable latency and failure rate.
 */

import type {
  BackendCapabilities,
  BackendHealthReport,
  ExecutionBackend,
  ExecutionHandle,
  ExecutionResult,
  ExecutionTask,
  OutputCompleteEvent,
  OutputEvent,
  OutputTextEvent,
  TokenUsage,
} from "@cortex/shared"

const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

export interface EchoBackendConfig {
  /** Artificial latency in ms before returning result. Default: 0. */
  latencyMs?: number
  /** Failure rate from 0.0 to 1.0. Default: 0.0 (never fails). */
  failureRate?: number
  /** Error classification when failing. Default: "transient". */
  failureClassification?: "transient" | "permanent" | "timeout" | "resource"
}

export class EchoBackend implements ExecutionBackend {
  readonly backendId = "echo"

  private latencyMs = 0
  private failureRate = 0
  private failureClassification: "transient" | "permanent" | "timeout" | "resource" = "transient"
  private started = false

  async start(config: Record<string, unknown>): Promise<void> {
    if (typeof config.latencyMs === "number") {
      this.latencyMs = config.latencyMs
    }
    if (typeof config.failureRate === "number") {
      this.failureRate = Math.max(0, Math.min(1, config.failureRate))
    }
    if (typeof config.failureClassification === "string") {
      this.failureClassification = config.failureClassification as typeof this.failureClassification
    }
    this.started = true
  }

  async stop(): Promise<void> {
    this.started = false
  }

  async healthCheck(): Promise<BackendHealthReport> {
    return {
      backendId: this.backendId,
      status: this.started ? "healthy" : "unhealthy",
      reason: this.started ? undefined : "Backend not started",
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      details: { latencyMs: this.latencyMs, failureRate: this.failureRate },
    }
  }

  async executeTask(task: ExecutionTask): Promise<ExecutionHandle> {
    if (!this.started) {
      throw new Error("EchoBackend not started")
    }

    const shouldFail = Math.random() < this.failureRate
    const startTime = Date.now()

    return new EchoHandle(
      task,
      this.latencyMs,
      shouldFail,
      this.failureClassification,
      startTime,
    )
  }

  getCapabilities(): BackendCapabilities {
    return {
      supportsStreaming: false,
      supportsFileEdit: false,
      supportsShellExecution: false,
      reportsTokenUsage: false,
      supportsCancellation: true,
      supportedGoalTypes: ["code_edit", "code_generate", "code_review", "shell_command", "research"],
      maxContextTokens: 100_000,
    }
  }

  /** Configure failure behavior at runtime (useful in tests). */
  configure(config: EchoBackendConfig): void {
    if (config.latencyMs !== undefined) this.latencyMs = config.latencyMs
    if (config.failureRate !== undefined) this.failureRate = config.failureRate
    if (config.failureClassification !== undefined) this.failureClassification = config.failureClassification
  }
}

// ──────────────────────────────────────────────────
// Echo Handle
// ──────────────────────────────────────────────────

class EchoHandle implements ExecutionHandle {
  readonly taskId: string

  private cancelled = false
  private resultPromise: Promise<ExecutionResult>
  private resolveResult!: (result: ExecutionResult) => void
  private resultResolved = false

  constructor(
    private readonly task: ExecutionTask,
    private readonly latencyMs: number,
    private readonly shouldFail: boolean,
    private readonly failureClassification: "transient" | "permanent" | "timeout" | "resource",
    private readonly startTime: number,
  ) {
    this.taskId = task.id

    this.resultPromise = new Promise<ExecutionResult>((resolve) => {
      this.resolveResult = resolve
    })
  }

  async *events(): AsyncIterable<OutputEvent> {
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs))
    }

    if (this.cancelled) return

    if (this.shouldFail) {
      const result: ExecutionResult = {
        taskId: this.taskId,
        status: "failed",
        exitCode: 1,
        summary: "Echo backend simulated failure",
        fileChanges: [],
        stdout: "",
        stderr: "Simulated failure",
        tokenUsage: { ...ZERO_TOKEN_USAGE },
        artifacts: [],
        durationMs: Date.now() - this.startTime,
        error: {
          message: "Echo backend simulated failure",
          classification: this.failureClassification,
          partialExecution: false,
        },
      }
      this.settleResult(result)

      const completeEvent: OutputCompleteEvent = {
        type: "complete",
        timestamp: new Date().toISOString(),
        result,
      }
      yield completeEvent
      return
    }

    // Echo the prompt back as a text event
    const textEvent: OutputTextEvent = {
      type: "text",
      timestamp: new Date().toISOString(),
      content: this.task.instruction.prompt,
    }
    yield textEvent

    // Build success result
    const result: ExecutionResult = {
      taskId: this.taskId,
      status: "completed",
      exitCode: 0,
      summary: this.task.instruction.prompt,
      fileChanges: [],
      stdout: this.task.instruction.prompt,
      stderr: "",
      tokenUsage: { ...ZERO_TOKEN_USAGE },
      artifacts: [],
      durationMs: Date.now() - this.startTime,
    }
    this.settleResult(result)

    const completeEvent: OutputCompleteEvent = {
      type: "complete",
      timestamp: new Date().toISOString(),
      result,
    }
    yield completeEvent
  }

  async result(): Promise<ExecutionResult> {
    return this.resultPromise
  }

  async cancel(reason: string): Promise<void> {
    this.cancelled = true
    this.settleResult({
      taskId: this.taskId,
      status: "cancelled",
      exitCode: null,
      summary: `Cancelled: ${reason}`,
      fileChanges: [],
      stdout: "",
      stderr: "",
      tokenUsage: { ...ZERO_TOKEN_USAGE },
      artifacts: [],
      durationMs: Date.now() - this.startTime,
    })
  }

  private settleResult(result: ExecutionResult): void {
    if (!this.resultResolved) {
      this.resultResolved = true
      this.resolveResult(result)
    }
  }
}
