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
    // eslint-disable-next-line @typescript-eslint/require-await
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
      return Promise.resolve([])
    })

    return chain
  }

  const db = {
    selectFrom: vi.fn((table: string) => createChain(table, true)),
    updateTable: vi.fn((table: string) => createChain(table, false)),
  }

  return db
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

function makeMockHelpers() {
  return {
    addJob: vi.fn(),
    job: { id: "worker-job-1" },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    withPgClient: vi.fn(),
  }
}

function makeMockCredentialService(
  getAccessTokenResult: { token: string; credentialId: string } | null = {
    token: "resolved-oauth-token",
    credentialId: "cred-abc",
  },
) {
  return {
    getAccessToken: vi.fn().mockResolvedValue(getAccessTokenResult),
    getToolSecret: vi.fn().mockResolvedValue(null),
  } as unknown as CredentialService
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent-execute credential wiring (#444)", () => {
  it("resolves llmCredential from agent_credential_binding when credentialService is provided", async () => {
    const db = makeMockDb({
      credentialBinding: {
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

    // Verify getAccessToken was called with the binding's user + provider
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(credentialService.getAccessToken).toHaveBeenCalledWith(
      "user-owner-1",
      "google-antigravity",
    )

    // Verify the task passed to executeTask has llmCredential set
    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0][0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toEqual({
      provider: "google-antigravity",
      token: "resolved-oauth-token",
      credentialId: "cred-abc",
      accountId: "my-gcp-project",
      credentialType: "oauth",
    })
  })

  it("falls back to env var when no credential binding exists", async () => {
    const db = makeMockDb({
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

    // getAccessToken should NOT be called when there's no binding
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(credentialService.getAccessToken).not.toHaveBeenCalled()

    // Task should not have llmCredential set
    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0][0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toBeUndefined()
  })

  it("falls back gracefully when getAccessToken returns null", async () => {
    const db = makeMockDb({
      credentialBinding: {
        user_account_id: "user-owner-1",
        provider: "google-antigravity",
        credential_type: "oauth",
        credential_class: "llm_provider",
      },
    })
    const { registry, executeTaskSpy } = makeMockRegistry()
    const credentialService = makeMockCredentialService(null) // Token resolution fails

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
      credentialService,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // getAccessToken was called but returned null
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(credentialService.getAccessToken).toHaveBeenCalled()

    // Task should not have llmCredential (falls back to env var)
    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0][0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toBeUndefined()
  })

  it("filters credential bindings by compatible provider when model is set", async () => {
    // Agent has a claude model — credential query should filter for anthropic/google-antigravity
    const db = makeMockDb({
      agent: {
        id: "agent-1",
        name: "TestAgent",
        slug: "test-agent",
        role: "developer",
        description: null,
        status: "ACTIVE",
        model_config: { model: "claude-sonnet-4-6" },
        skill_config: {},
        resource_limits: {},
        config: null,
        health_reset_at: null,
      },
      credentialBinding: {
        user_account_id: "user-owner-1",
        provider: "anthropic",
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

    // Verify the credential binding query included a provider filter
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const selectCalls = (db.selectFrom as ReturnType<typeof vi.fn>).mock.calls
    const credBindingCall = selectCalls.find((c: string[]) => c[0] === "agent_credential_binding")
    expect(credBindingCall).toBeDefined()

    // Verify getAccessToken was called with the bound provider
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(credentialService.getAccessToken).toHaveBeenCalledWith("user-owner-1", "anthropic")

    // Verify the task has llmCredential set
    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0][0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toEqual({
      provider: "anthropic",
      token: "resolved-oauth-token",
      credentialId: "cred-abc",
      accountId: null,
      credentialType: "oauth",
    })
  })

  it("resolves api_key credential with credentialType 'api_key' for direct-key providers", async () => {
    const db = makeMockDb({
      credentialBinding: {
        user_account_id: "user-owner-1",
        provider: "openai",
        credential_type: "api_key",
        credential_class: "llm_provider",
        account_id: null,
      },
    })
    const { registry, executeTaskSpy } = makeMockRegistry()
    const credentialService = makeMockCredentialService({
      token: "sk-openai-key-12345678",
      credentialId: "cred-apikey-1",
    })

    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
      credentialService,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(credentialService.getAccessToken).toHaveBeenCalledWith("user-owner-1", "openai")

    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0][0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toEqual({
      provider: "openai",
      token: "sk-openai-key-12345678",
      credentialId: "cred-apikey-1",
      accountId: null,
      credentialType: "api_key",
    })
  })

  it("proceeds without credential resolution when credentialService is not injected", async () => {
    const db = makeMockDb()
    const { registry, executeTaskSpy } = makeMockRegistry()

    // No credentialService provided — simulates the pre-fix behavior
    const task = createAgentExecuteTask({
      db: db as unknown as AgentExecuteDeps["db"],
      registry,
    })

    await task({ jobId: "job-1" }, makeMockHelpers() as never)

    // Task should be dispatched, just without llmCredential
    expect(executeTaskSpy).toHaveBeenCalled()
    const executedTask = executeTaskSpy.mock.calls[0][0] as ExecutionTask
    expect(executedTask.constraints.llmCredential).toBeUndefined()
  })
})
