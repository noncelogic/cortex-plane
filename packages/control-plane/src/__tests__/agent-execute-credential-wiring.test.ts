/**
 * Tests for credential wiring in agent-execute (issue #444).
 *
 * Verifies:
 * - credentialService is used to resolve LLM credentials from agent_credential_binding
 * - llmCredential is set on the task when a binding + valid token exist
 * - Falls back gracefully when no binding exists
 * - Falls back gracefully when getAccessToken returns null
 */

import type {
  BackendRegistry,
  ExecutionHandle,
  ExecutionResult,
  ExecutionTask,
  OutputEvent,
} from "@cortex/shared/backends"
import { describe, expect, it, vi } from "vitest"

import type { CredentialService } from "../auth/credential-service.js"
import { echoTool, ToolRegistry } from "../backends/tool-executor.js"
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
  return {
    taskId: result.taskId,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *events() {
      for (const event of events) {
        yield event
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async result() {
      return result
    },

    async cancel() {
      // no-op
    },
  }
}

interface MockDbOptions {
  job?: Record<string, unknown> | null
  agent?: Record<string, unknown> | null
  recentJobs?: Array<{ status: string }>
  /** The binding row returned by selectFrom("agent_credential_binding")...executeTakeFirst() */
  credentialBinding?: Record<string, unknown> | null
}

function makeMockDb(opts: MockDbOptions = {}) {
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
    health_reset_at: null,
  }

  const job = opts.job !== undefined ? opts.job : defaultJob
  const agent = opts.agent !== undefined ? opts.agent : defaultAgent
  const recentJobs = opts.recentJobs ?? []
  const credentialBinding = opts.credentialBinding ?? null
  const updateSets: Array<{ table: string; values: Record<string, unknown> }> = []

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
      chain[method] = vi.fn().mockReturnValue(chain)
    }

    chain.executeTakeFirst = vi.fn().mockImplementation(() => {
      if (tableName === "job") return Promise.resolve(job)
      if (tableName === "agent") return Promise.resolve(agent)
      if (tableName === "agent_credential_binding") return Promise.resolve(credentialBinding)
      if (tableName === "approval_request") return Promise.resolve(null)
      return Promise.resolve(null)
    })

    chain.executeTakeFirstOrThrow = vi.fn().mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return (chain.executeTakeFirst as ReturnType<typeof vi.fn>)()
    })

    chain.execute = vi.fn().mockImplementation(() => {
      if (isSelect && tableName === "job") {
        return Promise.resolve(recentJobs)
      }
      if (isSelect && tableName === "agent_credential_binding") {
        return Promise.resolve(credentialBinding ? [credentialBinding] : [])
      }
      return Promise.resolve([])
    })

    return chain
  }

  const db = {
    selectFrom: vi.fn((table: string) => createChain(table, true)),
    updateTable: vi.fn((table: string) => {
      const chain = createChain(table, false)
      chain.set = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push({ table, values })
        return chain
      })
      return chain
    }),
  }

  return { db, updateSets }
}

function makeMockRegistry(handle: ExecutionHandle = createMockHandle()) {
  const executeTaskSpy = vi.fn().mockResolvedValue(handle)
  return {
    registry: {
      routeTask: vi.fn().mockReturnValue({
        backend: {
          backendId: "mock-backend",
          executeTask: executeTaskSpy,
        },
        providerId: "mock-provider",
      }),
      acquirePermit: vi.fn().mockResolvedValue({ release: vi.fn() }),
      recordOutcome: vi.fn(),
    } as unknown as BackendRegistry,
    executeTaskSpy,
  }
}

function makeMockRegistryWithAgentRegistry(handle: ExecutionHandle = createMockHandle()) {
  const executeTaskSpy = vi.fn().mockResolvedValue(handle)
  const agentRegistry = new ToolRegistry()
  agentRegistry.register({
    name: "web_search",
    description: "search",
    inputSchema: { type: "object" },
    execute: vi.fn().mockResolvedValue("ok"),
  })
  agentRegistry.register({
    name: "mcp:filesystem:read_file",
    description: "read",
    inputSchema: { type: "object" },
    execute: vi.fn().mockResolvedValue("ok"),
  })

  return {
    registry: {
      routeTask: vi.fn().mockReturnValue({
        backend: {
          backendId: "mock-backend",
          createAgentRegistry: vi.fn().mockResolvedValue(agentRegistry),
          executeTask: executeTaskSpy,
        },
        providerId: "mock-provider",
      }),
      acquirePermit: vi.fn().mockResolvedValue({ release: vi.fn() }),
      recordOutcome: vi.fn(),
    } as unknown as BackendRegistry,
    executeTaskSpy,
  }
}

function makeMockHelpers() {
  return {
    addJob: vi.fn(),
    job: { id: "worker-job-1" },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    withPgClient: vi.fn(),
  }
}

function makeMockCredentialService(
  resolveCredentialAccessTokenResult:
    | {
        ok: true
        token: string
        credentialId: string
        provider: string
        credentialType: "oauth" | "api_key"
        status: "active"
      }
    | {
        ok: false
        credentialId: string | null
        provider: string | null
        credentialType: "oauth" | "api_key" | null
        status: "active" | "error" | "expired" | "revoked"
        code: string
        message: string
        requiresReauth: boolean
      } = {
    ok: true,
    token: "resolved-oauth-token",
    credentialId: "cred-abc",
    provider: "anthropic",
    credentialType: "oauth",
    status: "active",
  },
) {
  return {
    resolveCredentialAccessToken: vi.fn().mockResolvedValue(resolveCredentialAccessTokenResult),
    getToolSecret: vi.fn().mockResolvedValue(null),
  } as unknown as CredentialService
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-execute credential wiring (#444)", () => {
  it("resolves llmCredential from agent_credential_binding when credentialService is provided", async () => {
    const { db } = makeMockDb({
      credentialBinding: {
        id: "binding-cred-1",
        user_account_id: "user-owner-1",
        provider: "google-antigravity",
        credential_type: "oauth",
        credential_class: "llm_provider",
        account_id: "my-gcp-project",
      },
    })
    const { registry, executeTaskSpy } = makeMockRegistry()
    const credentialService = makeMockCredentialService()

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
      credentialService,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Verify resolution was tied to the bound credential ID
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(credentialService.resolveCredentialAccessToken).toHaveBeenCalledWith("binding-cred-1", {
      agentId: "agent-1",
      jobId: "job-1",
    })

    // Verify the task passed to executeTask has llmCredential set
    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0]![0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toEqual({
      provider: "google-antigravity",
      token: "resolved-oauth-token",
      credentialId: "cred-abc",
      accountId: "my-gcp-project",
      credentialType: "oauth",
    })
  })

  it("falls back to env var when no credential binding exists", async () => {
    const { db } = makeMockDb({
      credentialBinding: null, // No binding
    })
    const { registry, executeTaskSpy } = makeMockRegistry()
    const credentialService = makeMockCredentialService()

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
      credentialService,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Bound credential resolution should NOT be called when there's no binding
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(credentialService.resolveCredentialAccessToken).not.toHaveBeenCalled()

    // Task should not have llmCredential set
    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0]![0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toBeUndefined()
  })

  it("fails clearly when a bound OAuth credential requires re-authentication", async () => {
    const { db } = makeMockDb({
      credentialBinding: {
        id: "binding-cred-2",
        user_account_id: "user-owner-1",
        provider: "google-antigravity",
        credential_type: "oauth",
        credential_class: "llm_provider",
      },
    })
    const { registry, executeTaskSpy } = makeMockRegistry()
    const credentialService = makeMockCredentialService({
      ok: false,
      credentialId: "binding-cred-2",
      provider: "google-antigravity",
      credentialType: "oauth",
      status: "revoked",
      code: "reauth_required",
      message: "Refresh token is invalid or revoked. Re-authenticate this provider.",
      requiresReauth: true,
    })

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
      credentialService,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(credentialService.resolveCredentialAccessToken).toHaveBeenCalledWith("binding-cred-2", {
      agentId: "agent-1",
      jobId: "job-1",
    })
    expect(executeTaskSpy).not.toHaveBeenCalled()
  })

  it("selects the bound provider/model pair and passes it into execution", async () => {
    const { db } = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: { provider: "google-antigravity", model: "claude-sonnet-4-5" },
        skill_config: {},
        resource_limits: {},
        config: null,
        health_reset_at: null,
      },
      credentialBinding: {
        id: "binding-cred-3",
        user_account_id: "user-owner-1",
        provider: "google-antigravity",
        credential_type: "oauth",
        credential_class: "llm_provider",
        account_id: null,
      },
    })
    const { registry, executeTaskSpy } = makeMockRegistry()
    const credentialService = makeMockCredentialService()

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
      credentialService,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Verify the execution path resolved the specific bound credential
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(credentialService.resolveCredentialAccessToken).toHaveBeenCalledWith("binding-cred-3", {
      agentId: "agent-1",
      jobId: "job-1",
    })

    // Verify the task has llmCredential set
    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0]![0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toEqual({
      provider: "google-antigravity",
      token: "resolved-oauth-token",
      credentialId: "cred-abc",
      accountId: null,
      credentialType: "oauth",
    })
    expect(executedTask.constraints.model).toBe("claude-sonnet-4-5")
  })

  it("fails instead of silently falling back when the configured provider is not bound", async () => {
    const { db, updateSets } = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: { provider: "google-antigravity", model: "claude-sonnet-4-5" },
        skill_config: {},
        resource_limits: {},
        config: null,
        health_reset_at: null,
      },
      credentialBinding: {
        id: "binding-cred-openai",
        user_account_id: "user-owner-1",
        provider: "openai",
        credential_type: "api_key",
        credential_class: "llm_provider",
        account_id: null,
      },
    })
    const { registry, executeTaskSpy } = makeMockRegistry()
    const credentialService = makeMockCredentialService()

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
      credentialService,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    expect(executeTaskSpy).not.toHaveBeenCalled()
    const failedUpdate = updateSets.find(
      (entry) =>
        entry.table === "job" &&
        entry.values.status === "FAILED" &&
        typeof entry.values.error === "object" &&
        entry.values.error !== null,
    )
    expect(failedUpdate).toBeDefined()
    expect(failedUpdate?.values.error).toEqual(
      expect.objectContaining({
        code: "provider_unbound",
        provider: "google-antigravity",
        model: "claude-sonnet-4-5",
      }),
    )
  })

  it("resolves api_key credential with credentialType 'api_key' for direct-key providers", async () => {
    const { db } = makeMockDb({
      credentialBinding: {
        id: "binding-cred-4",
        user_account_id: "user-owner-1",
        provider: "openai",
        credential_type: "api_key",
        credential_class: "llm_provider",
        account_id: null,
      },
    })
    const { registry, executeTaskSpy } = makeMockRegistry()
    const credentialService = makeMockCredentialService({
      ok: true,
      token: "sk-openai-key-12345678",
      credentialId: "cred-apikey-1",
      provider: "openai",
      credentialType: "api_key",
      status: "active",
    })

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
      credentialService,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(credentialService.resolveCredentialAccessToken).toHaveBeenCalledWith("binding-cred-4", {
      agentId: "agent-1",
      jobId: "job-1",
    })

    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0]![0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toEqual({
      provider: "openai",
      token: "sk-openai-key-12345678",
      credentialId: "cred-apikey-1",
      accountId: null,
      credentialType: "api_key",
    })
  })

  it("proceeds without credential resolution when credentialService is not injected", async () => {
    const { db } = makeMockDb()
    const { registry, executeTaskSpy } = makeMockRegistry()

    // No credentialService provided — simulates the pre-fix behavior
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Task should be dispatched, just without llmCredential
    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0]![0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toBeUndefined()
  })

  it("injects truthful runtime capability disclosure into the execution system prompt", async () => {
    const { db } = makeMockDb()
    const { registry, executeTaskSpy } = makeMockRegistry()

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    const executedTask = executeTaskSpy.mock.calls[0]![0] as ExecutionTask
    expect(executedTask.context.systemPrompt).toContain("Runtime capability disclosure:")
    expect(executedTask.context.systemPrompt).toContain("Workspace root: /workspace.")
    expect(executedTask.context.systemPrompt).toContain(
      "Filesystem scope: this run is configured with /workspace as its workspace root.",
    )
    expect(executedTask.context.systemPrompt).toContain(
      "MCP tools exposed by Cortex: unavailable for this run.",
    )
    expect(executedTask.context.systemPrompt).toContain(
      "OS command availability: unknown until verified in this runtime.",
    )
  })

  it("uses the actual resolved registry to disclose MCP availability", async () => {
    const { db } = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: {},
        skill_config: { allowedTools: ["web_search", "mcp:filesystem:read_file"] },
        resource_limits: {},
        config: null,
        health_reset_at: null,
      },
    })
    const { registry, executeTaskSpy } = makeMockRegistryWithAgentRegistry()

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    const executedTask = executeTaskSpy.mock.calls[0]![0] as ExecutionTask
    expect(executedTask.context.systemPrompt).toContain(
      "MCP tools exposed by Cortex: available (mcp:filesystem:read_file).",
    )
    expect(executedTask.context.systemPrompt).toContain(
      "Browser tools exposed by Cortex: unavailable for this run.",
    )
    expect(executedTask.context.systemPrompt).toContain(
      "Exposed tool names: mcp:filesystem:read_file, web_search.",
    )
  })

  it("injects a runtime tool manifest and guarded executable tools for chat runs without relying on the feature flag", async () => {
    const { db } = makeMockDb({
      job: {
        id: "job-1",
        agent_id: "agent-1",
        status: "SCHEDULED",
        attempt: 0,
        max_attempts: 3,
        timeout_seconds: 300,
        session_id: null,
        payload: { type: "CHAT_RESPONSE", prompt: "hello", goalType: "research" },
        error: null,
        result: null,
        started_at: null,
        completed_at: null,
        heartbeat_at: null,
        approval_expires_at: null,
      },
    })
    const executeTaskSpy = vi.fn().mockResolvedValue(createMockHandle())
    const registry = {
      routeTask: vi.fn().mockReturnValue({
        backend: {
          backendId: "mock-backend",
          createAgentRegistry: vi.fn(),
          executeTask: executeTaskSpy,
        },
        providerId: "mock-provider",
      }),
      acquirePermit: vi.fn().mockResolvedValue({ release: vi.fn() }),
      recordOutcome: vi.fn(),
    } as unknown as BackendRegistry

    const capabilityAssembler = {
      resolveEffectiveTools: vi.fn().mockResolvedValue([
        {
          toolRef: "echo",
          bindingId: "binding-echo",
          approvalPolicy: "auto",
          approvalCondition: null,
          rateLimit: null,
          costBudget: null,
          dataScope: null,
          source: { kind: "builtin" },
          toolDefinition: echoTool,
        },
      ]),
      buildGuardedRegistry: vi.fn().mockImplementation(() => {
        const toolRegistry = new ToolRegistry()
        toolRegistry.register(echoTool)
        return toolRegistry
      }),
    }

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
      capabilityAssembler: capabilityAssembler as never,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    const executedTask = executeTaskSpy.mock.calls[0]![0] as ExecutionTask
    const guardedRegistry = executeTaskSpy.mock.calls[0]![1] as ToolRegistry

    expect(executedTask.context.runtimeToolManifest?.version).toBe("v1")
    expect(typeof executedTask.context.runtimeToolManifest?.assembledAt).toBe("string")
    expect(executedTask.context.runtimeToolManifest?.tools).toEqual([
      {
        toolRef: "echo",
        runtimeName: "echo",
        description: echoTool.description,
        inputSchema: echoTool.inputSchema,
        source: { kind: "builtin" },
      },
    ])
    expect(executedTask.context.systemPrompt).toContain("Exposed tool names: echo.")
    expect(guardedRegistry.get("echo")).toBeDefined()
  })
})
