/**
 * Unit tests for the circuit breaker wiring in agent-execute.
 *
 * Verifies:
 * - Pre-dispatch quarantine check hydrates consecutive failure count from DB
 * - Token budget exceeded mid-job cancels execution
 * - Successful job resets failure counter (no quarantine)
 * - Failed job triggers quarantine when threshold reached
 * - Quarantined agent status check rejects dispatch
 */

import type {
  BackendRegistry,
  ExecutionHandle,
  ExecutionResult,
  OutputEvent,
} from "@cortex/shared/backends"
import { afterEach, describe, expect, it, vi } from "vitest"

import { type AgentExecuteDeps, createAgentExecuteTask } from "../worker/tasks/agent-execute.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    taskId: "test-task",
    status: "completed",
    exitCode: 0,
    summary: "done",
    fileChanges: [],
    stdout: "",
    stderr: "",
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    artifacts: [],
    durationMs: 500,
    ...overrides,
  }
}

function createMockHandle(
  result: ExecutionResult = createMockResult(),
  events: OutputEvent[] = [],
): ExecutionHandle {
  let cancelled = false
  let cancelReason: string | undefined
  return {
    taskId: result.taskId,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *events() {
      for (const event of events) {
        if (cancelled) return
        yield event
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async result() {
      if (cancelled) return { ...result, status: "cancelled" as const }
      return result
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async cancel(reason: string) {
      cancelled = true
      cancelReason = reason
    },
    get _cancelReason() {
      return cancelReason
    },
  }
}

interface MockDbReturns {
  /** selectFrom("job").selectAll().where().executeTakeFirst() — returns the job record */
  job?: Record<string, unknown> | null
  /** selectFrom("agent").selectAll().where().executeTakeFirst() — returns the agent record */
  agent?: Record<string, unknown> | null
  /** selectFrom("job").select(["status","error"]).where("agent_id",...).orderBy(...).limit(...).execute() — recent jobs */
  recentJobs?: Array<{ status: string; error?: Record<string, unknown> | null }>
}

function makeMockDb(returns: MockDbReturns = {}) {
  const defaultJob = {
    id: "job-1",
    agent_id: "agent-1",
    status: "SCHEDULED",
    attempt: 0,
    max_attempts: 3,
    timeout_seconds: 300,
    session_id: null,
    payload: { prompt: "test task", goalType: "code_edit" },
    error: null,
    result: null,
    started_at: null,
    completed_at: null,
    heartbeat_at: null,
    approval_expires_at: null,
  }

  const defaultAgent = {
    id: "agent-1",
    name: "TestAgent",
    slug: "test-agent",
    role: "developer",
    description: null,
    status: "ACTIVE",
    model_config: {},
    skill_config: {},
    resource_limits: {},
    config: null,
  }

  const job = returns.job !== undefined ? returns.job : defaultJob
  const agent = returns.agent !== undefined ? returns.agent : defaultAgent
  const recentJobs = returns.recentJobs ?? []

  // Track all set() calls for verification
  const setCalls: Array<{ table: string; values: Record<string, unknown> }> = []

  function createChain(tableName: string, isSelect: boolean) {
    const chain: Record<string, unknown> = {}

    for (const method of [
      "select",
      "selectAll",
      "set",
      "where",
      "innerJoin",
      "returning",
      "orderBy",
      "limit",
    ]) {
      if (method === "set") {
        chain[method] = vi.fn((values: Record<string, unknown>) => {
          setCalls.push({ table: tableName, values })
          return chain
        })
      } else {
        chain[method] = vi.fn().mockReturnValue(chain)
      }
    }

    chain.executeTakeFirst = vi.fn().mockImplementation(() => {
      if (tableName === "job") return Promise.resolve(job)
      if (tableName === "agent") return Promise.resolve(agent)
      if (tableName === "agent_credential_binding") return Promise.resolve(null)
      if (tableName === "approval_request") return Promise.resolve(null)
      return Promise.resolve(null)
    })

    chain.executeTakeFirstOrThrow = vi.fn().mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return (chain.executeTakeFirst as ReturnType<typeof vi.fn>)()
    })

    chain.execute = vi.fn().mockImplementation(() => {
      // For selectFrom("job")...orderBy(...).limit(...).execute() — recent jobs query
      if (isSelect && tableName === "job") {
        return Promise.resolve(recentJobs)
      }
      return Promise.resolve([])
    })

    return chain
  }

  const db = {
    selectFrom: vi.fn((table: string) => createChain(table, true)),
    updateTable: vi.fn((table: string) => createChain(table, false)),
    _setCalls: setCalls,
  }

  return db
}

function makeMockRegistry(handle: ExecutionHandle = createMockHandle()) {
  return {
    routeTask: vi.fn().mockReturnValue({
      backend: {
        backendId: "mock-backend",
        executeTask: vi.fn().mockResolvedValue(handle),
      },
      providerId: "mock-provider",
    }),
    acquirePermit: vi.fn().mockResolvedValue({ release: vi.fn() }),
    recordOutcome: vi.fn(),
  } as unknown as BackendRegistry
}

function makeMockHelpers() {
  return {
    addJob: vi.fn(),
    job: { id: "worker-job-1" },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    withPgClient: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-execute circuit breaker wiring", () => {
  it("quarantines agent pre-dispatch when 3 consecutive failed jobs in DB", async () => {
    const db = makeMockDb({
      recentJobs: [{ status: "FAILED" }, { status: "FAILED" }, { status: "FAILED" }],
    })

    const registry = makeMockRegistry()
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Verify agent status was set to QUARANTINED
    const agentUpdate = db._setCalls.find(
      (c) => c.table === "agent" && c.values.status === "QUARANTINED",
    )
    expect(agentUpdate).toBeDefined()

    // Verify job was failed with QUARANTINED category
    const jobFail = db._setCalls.find(
      (c) =>
        c.table === "job" &&
        c.values.status === "FAILED" &&
        (c.values.error as Record<string, unknown>)?.category === "QUARANTINED",
    )
    expect(jobFail).toBeDefined()

    // Backend should NOT have been called
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(registry.routeTask).not.toHaveBeenCalled()
  })

  it("does not quarantine when fewer than 3 consecutive failures", async () => {
    const handle = createMockHandle()
    const db = makeMockDb({
      recentJobs: [{ status: "FAILED" }, { status: "FAILED" }],
    })

    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Agent should NOT be quarantined
    const agentQuarantine = db._setCalls.find(
      (c) => c.table === "agent" && c.values.status === "QUARANTINED",
    )
    expect(agentQuarantine).toBeUndefined()

    // Backend SHOULD have been called
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(registry.routeTask).toHaveBeenCalled()
  })

  it("rejects dispatch when agent status is not ACTIVE (already quarantined)", async () => {
    const db = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "QUARANTINED",
        model_config: {},
        skill_config: {},
        resource_limits: {},
        config: null,
      },
    })

    const registry = makeMockRegistry()
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    // Should throw because agent is QUARANTINED
    await expect(task({ jobId: "job-1" }, makeMockHelpers() as never)).rejects.toThrow(
      "QUARANTINED",
    )

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(registry.routeTask).not.toHaveBeenCalled()
  })

  it("cancels execution when token budget is exceeded mid-job", async () => {
    // Use a very low token budget
    const db = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: {},
        skill_config: {},
        resource_limits: {
          circuitBreaker: { tokenBudgetPerJob: 100 },
        },
        config: null,
      },
      recentJobs: [],
    })

    // Create events that exceed the token budget
    const events: OutputEvent[] = [
      {
        type: "usage",
        timestamp: new Date().toISOString(),
        tokenUsage: {
          inputTokens: 80,
          outputTokens: 30,
          costUsd: 0.001,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      {
        type: "text",
        timestamp: new Date().toISOString(),
        content: "still going...",
      },
    ]

    const handle = createMockHandle(createMockResult(), events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // The handle should have been cancelled due to token budget
    expect((handle as unknown as { _cancelReason: string })._cancelReason).toBe(
      "token_budget_exceeded",
    )
  })

  it("records job success and does not quarantine after successful execution", async () => {
    const db = makeMockDb({
      recentJobs: [{ status: "FAILED" }, { status: "FAILED" }], // 2 failures, just below threshold
    })

    const events: OutputEvent[] = [
      {
        type: "text",
        timestamp: new Date().toISOString(),
        content: "Done!",
      },
    ]

    const handle = createMockHandle(createMockResult(), events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Agent should NOT be quarantined (success resets counter)
    const agentQuarantine = db._setCalls.find(
      (c) => c.table === "agent" && c.values.status === "QUARANTINED",
    )
    expect(agentQuarantine).toBeUndefined()

    // Job should be COMPLETED
    const jobComplete = db._setCalls.find(
      (c) => c.table === "job" && c.values.status === "COMPLETED",
    )
    expect(jobComplete).toBeDefined()
  })

  it("quarantines agent after failed execution when at failure threshold", async () => {
    // 2 prior failures + this one = 3 total → quarantine
    const db = makeMockDb({
      recentJobs: [{ status: "FAILED" }, { status: "FAILED" }],
    })

    const events: OutputEvent[] = [
      { type: "text", timestamp: new Date().toISOString(), content: "Working..." },
    ]

    const failedResult = createMockResult({
      status: "failed",
      error: { message: "Agent crashed", classification: "transient", partialExecution: false },
    })
    const handle = createMockHandle(failedResult, events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // After the failed result, the CB has 2 (hydrated) + 1 (this job) = 3 failures
    // Step 11b should quarantine the agent
    const agentQuarantine = db._setCalls.find(
      (c) => c.table === "agent" && c.values.status === "QUARANTINED",
    )
    expect(agentQuarantine).toBeDefined()
  })

  it("monitors tool_use events for rate limiting", async () => {
    const db = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: {},
        skill_config: {},
        resource_limits: {
          circuitBreaker: {
            toolCallRateLimit: { maxCalls: 2, windowSeconds: 300 },
          },
        },
        config: null,
      },
      recentJobs: [],
    })

    // 3 tool_use events — exceeds limit of 2
    const events: OutputEvent[] = [
      { type: "tool_use", timestamp: new Date().toISOString(), toolName: "grep", toolInput: {} },
      { type: "tool_use", timestamp: new Date().toISOString(), toolName: "read", toolInput: {} },
      { type: "tool_use", timestamp: new Date().toISOString(), toolName: "write", toolInput: {} },
    ]

    const handle = createMockHandle(createMockResult(), events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // The handle should have been cancelled due to tool call rate
    expect((handle as unknown as { _cancelReason: string })._cancelReason).toBe(
      "tool_call_rate_exceeded",
    )
  })

  it("accounts llm rate limiting by logical turn, not streamed text chunks", async () => {
    const db = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: {},
        skill_config: {},
        resource_limits: {
          circuitBreaker: {
            llmCallRateLimit: { maxCalls: 2, windowSeconds: 300 },
          },
        },
        config: null,
      },
      recentJobs: [],
    })

    const events: OutputEvent[] = [
      { type: "text", timestamp: new Date().toISOString(), content: "chunk 1" },
      { type: "text", timestamp: new Date().toISOString(), content: "chunk 2" },
      { type: "tool_use", timestamp: new Date().toISOString(), toolName: "grep", toolInput: {} },
      {
        type: "tool_result",
        timestamp: new Date().toISOString(),
        toolName: "grep",
        output: "done",
        isError: false,
      },
      { type: "text", timestamp: new Date().toISOString(), content: "chunk 3" },
      { type: "text", timestamp: new Date().toISOString(), content: "chunk 4" },
    ]

    const handle = createMockHandle(createMockResult(), events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    expect((handle as unknown as { _cancelReason?: string })._cancelReason).toBeUndefined()
  })

  it("cancels execution when logical llm turns exceed the rate limit", async () => {
    const db = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: {},
        skill_config: {},
        resource_limits: {
          circuitBreaker: {
            llmCallRateLimit: { maxCalls: 2, windowSeconds: 300 },
          },
        },
        config: null,
      },
      recentJobs: [],
    })

    const events: OutputEvent[] = [
      { type: "text", timestamp: new Date().toISOString(), content: "turn 1 chunk 1" },
      { type: "tool_use", timestamp: new Date().toISOString(), toolName: "grep", toolInput: {} },
      {
        type: "tool_result",
        timestamp: new Date().toISOString(),
        toolName: "grep",
        output: "done",
        isError: false,
      },
      { type: "text", timestamp: new Date().toISOString(), content: "turn 2 chunk 1" },
      { type: "tool_use", timestamp: new Date().toISOString(), toolName: "read", toolInput: {} },
      {
        type: "tool_result",
        timestamp: new Date().toISOString(),
        toolName: "read",
        output: "done",
        isError: false,
      },
      { type: "text", timestamp: new Date().toISOString(), content: "turn 3 chunk 1" },
    ]

    const handle = createMockHandle(createMockResult(), events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    expect((handle as unknown as { _cancelReason: string })._cancelReason).toBe(
      "llm_call_rate_exceeded",
    )
  })

  it("records tool errors from tool_result events", async () => {
    const db = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: {},
        skill_config: {},
        resource_limits: {
          circuitBreaker: { maxToolErrorsPerJob: 2 },
        },
        config: null,
      },
      recentJobs: [],
    })

    // 2 tool_result errors — should still proceed (shouldAbortJob checks, but we don't abort inline)
    // The circuit breaker tracks them for potential future use
    const events: OutputEvent[] = [
      {
        type: "tool_result",
        timestamp: new Date().toISOString(),
        toolName: "grep",
        output: "error",
        isError: true,
      },
      {
        type: "tool_result",
        timestamp: new Date().toISOString(),
        toolName: "read",
        output: "not found",
        isError: true,
      },
      {
        type: "text",
        timestamp: new Date().toISOString(),
        content: "Done",
      },
    ]

    const handle = createMockHandle(createMockResult(), events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    // Should complete without error — tool errors are tracked but don't cancel by default
    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    const jobComplete = db._setCalls.find(
      (c) => c.table === "job" && c.values.status === "COMPLETED",
    )
    expect(jobComplete).toBeDefined()
  })

  it("respects custom circuit breaker config from agent resource_limits", async () => {
    // Custom threshold of 5 failures — 3 prior failures should NOT quarantine
    const db = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: {},
        skill_config: {},
        resource_limits: {
          circuitBreaker: { maxConsecutiveFailures: 5 },
        },
        config: null,
      },
      recentJobs: [{ status: "FAILED" }, { status: "FAILED" }, { status: "FAILED" }],
    })

    const events: OutputEvent[] = [
      { type: "text", timestamp: new Date().toISOString(), content: "Done" },
    ]
    const handle = createMockHandle(createMockResult(), events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Should NOT quarantine (3 < 5 threshold)
    const agentQuarantine = db._setCalls.find(
      (c) => c.table === "agent" && c.values.status === "QUARANTINED",
    )
    expect(agentQuarantine).toBeUndefined()

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(registry.routeTask).toHaveBeenCalled()
  })

  it("does not count permanent (config) errors toward quarantine (#450)", async () => {
    // 2 prior runtime failures + this permanent (config) error should NOT quarantine
    // because permanent errors represent config issues, not runtime failures.
    const db = makeMockDb({
      recentJobs: [{ status: "FAILED" }, { status: "FAILED" }],
    })

    const events: OutputEvent[] = [
      { type: "text", timestamp: new Date().toISOString(), content: "Working..." },
    ]

    const failedResult = createMockResult({
      status: "failed",
      error: {
        message: "Authentication failed — invalid API key",
        classification: "permanent",
        partialExecution: false,
      },
    })
    const handle = createMockHandle(failedResult, events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Agent should NOT be quarantined — permanent errors are config issues
    const agentQuarantine = db._setCalls.find(
      (c) => c.table === "agent" && c.values.status === "QUARANTINED",
    )
    expect(agentQuarantine).toBeUndefined()
  })

  it("skips config-error jobs during hydration (#450)", async () => {
    // 3 prior FAILED jobs, but 1 has a PERMANENT error category (config error).
    // Only 2 runtime failures should count → below threshold → no quarantine.
    const db = makeMockDb({
      recentJobs: [
        { status: "FAILED", error: null },
        { status: "FAILED", error: { category: "PERMANENT", message: "Auth failed" } },
        { status: "FAILED", error: null },
      ],
    })

    const events: OutputEvent[] = [
      { type: "text", timestamp: new Date().toISOString(), content: "Done" },
    ]
    const handle = createMockHandle(createMockResult(), events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Should NOT quarantine pre-dispatch: only 2 runtime failures (< 3 threshold)
    const agentQuarantine = db._setCalls.find(
      (c) => c.table === "agent" && c.values.status === "QUARANTINED",
    )
    expect(agentQuarantine).toBeUndefined()

    // Backend SHOULD have been called
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(registry.routeTask).toHaveBeenCalled()
  })

  it("skips CONTEXT_BUDGET_EXCEEDED jobs during hydration (#450)", async () => {
    // 3 prior FAILED jobs, but 1 has CONTEXT_BUDGET_EXCEEDED (config error).
    const db = makeMockDb({
      recentJobs: [
        { status: "FAILED", error: null },
        { status: "FAILED", error: { category: "CONTEXT_BUDGET_EXCEEDED", message: "too large" } },
        { status: "FAILED", error: null },
      ],
    })

    const events: OutputEvent[] = [
      { type: "text", timestamp: new Date().toISOString(), content: "Done" },
    ]
    const handle = createMockHandle(createMockResult(), events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Should NOT quarantine: only 2 runtime failures
    const agentQuarantine = db._setCalls.find(
      (c) => c.table === "agent" && c.values.status === "QUARANTINED",
    )
    expect(agentQuarantine).toBeUndefined()

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(registry.routeTask).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // DISABLE_AGENT_QUARANTINE env var (#677)
  // -------------------------------------------------------------------------

  describe("with DISABLE_AGENT_QUARANTINE=true", () => {
    afterEach(() => {
      delete process.env.DISABLE_AGENT_QUARANTINE
    })

    it("does NOT quarantine pre-dispatch even with 3 consecutive failures (#677)", async () => {
      process.env.DISABLE_AGENT_QUARANTINE = "true"
      const db = makeMockDb({
        recentJobs: [{ status: "FAILED" }, { status: "FAILED" }, { status: "FAILED" }],
      })

      const handle = createMockHandle()
      const registry = makeMockRegistry(handle)
      const task = createAgentExecuteTask({
        db: db as unknown as AgentExecuteDeps["db"],
        registry,
      })

      await task({ jobId: "job-1" }, makeMockHelpers() as never)

      // Agent should NOT be quarantined
      const agentQuarantine = db._setCalls.find(
        (c) => c.table === "agent" && c.values.status === "QUARANTINED",
      )
      expect(agentQuarantine).toBeUndefined()

      // Backend SHOULD have been called — job proceeds normally
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(registry.routeTask).toHaveBeenCalled()
    })

    it("does NOT quarantine post-execution even at failure threshold (#677)", async () => {
      process.env.DISABLE_AGENT_QUARANTINE = "true"
      const db = makeMockDb({
        recentJobs: [{ status: "FAILED" }, { status: "FAILED" }],
      })

      const events: OutputEvent[] = [
        { type: "text", timestamp: new Date().toISOString(), content: "Working..." },
      ]

      const failedResult = createMockResult({
        status: "failed",
        error: {
          message: "Agent crashed",
          classification: "transient",
          partialExecution: false,
        },
      })
      const handle = createMockHandle(failedResult, events)
      const registry = makeMockRegistry(handle)
      const task = createAgentExecuteTask({
        db: db as unknown as AgentExecuteDeps["db"],
        registry,
      })

      await task({ jobId: "job-1" }, makeMockHelpers() as never)

      // Agent should NOT be quarantined even though threshold is reached
      const agentQuarantine = db._setCalls.find(
        (c) => c.table === "agent" && c.values.status === "QUARANTINED",
      )
      expect(agentQuarantine).toBeUndefined()
    })

    it("allows QUARANTINED agents to execute (#677)", async () => {
      process.env.DISABLE_AGENT_QUARANTINE = "true"
      const handle = createMockHandle()
      const db = makeMockDb({
        agent: {
          id: "agent-1",
          name: "TestAgent",
          slug: "test-agent",
          role: "developer",
          description: null,
          status: "QUARANTINED",
          model_config: {},
          skill_config: {},
          resource_limits: {},
          config: null,
        },
      })

      const registry = makeMockRegistry(handle)
      const task = createAgentExecuteTask({
        db: db as unknown as AgentExecuteDeps["db"],
        registry,
      })

      // Should NOT throw — quarantined agents proceed when disabled
      await task({ jobId: "job-1" }, makeMockHelpers() as never)

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(registry.routeTask).toHaveBeenCalled()
    })
  })

  it("does not quarantine when health_reset_at filters out prior failures (#443)", async () => {
    // Agent has health_reset_at set — simulates release from quarantine.
    // The hydration query filters jobs completed before health_reset_at,
    // so recentJobs comes back empty even though there were prior failures.
    const db = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: {},
        skill_config: {},
        resource_limits: {},
        config: null,
        health_reset_at: new Date(),
      },
      // After filtering, no recent jobs remain (all old failures are excluded)
      recentJobs: [],
    })

    const events: OutputEvent[] = [
      { type: "text", timestamp: new Date().toISOString(), content: "Done!" },
    ]

    const handle = createMockHandle(createMockResult(), events)
    const registry = makeMockRegistry(handle)
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Agent should NOT be quarantined
    const agentQuarantine = db._setCalls.find(
      (c) => c.table === "agent" && c.values.status === "QUARANTINED",
    )
    expect(agentQuarantine).toBeUndefined()

    // Job should be COMPLETED
    const jobComplete = db._setCalls.find(
      (c) => c.table === "job" && c.values.status === "COMPLETED",
    )
    expect(jobComplete).toBeDefined()

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(registry.routeTask).toHaveBeenCalled()
  })
})
