/**
 * Tests for credential injection into the execution pipeline (issue #276).
 *
 * Covers:
 *   Part A: LLM credential injection (per-job override via HttpLlmBackend)
 *   Part B: Tool credential injection (webhook tools with credential refs)
 *   Part C: Backward compatibility (agents without credential bindings)
 */

import type { ExecutionTask, OutputEvent } from "@cortex/shared/backends"
import { describe, expect, it, vi } from "vitest"

import { HttpLlmBackend } from "../backends/http-llm.js"
import { createAgentToolRegistry } from "../backends/tool-executor.js"
import {
  createWebhookTool,
  type CredentialResolver,
  parseWebhookTools,
  type WebhookToolSpec,
} from "../backends/tools/webhook.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides?: Partial<ExecutionTask>): ExecutionTask {
  return {
    id: "task-cred-001",
    jobId: "job-cred-001",
    agentId: "agent-cred-001",
    instruction: {
      prompt: "Test prompt",
      goalType: "research",
    },
    context: {
      workspacePath: "/workspace",
      systemPrompt: "You are a test assistant.",
      memories: [],
      relevantFiles: {},
      environment: {},
    },
    constraints: {
      timeoutMs: 30_000,
      maxTokens: 4096,
      model: "claude-sonnet-4-5-20250929",
      allowedTools: [],
      deniedTools: [],
      maxTurns: 1,
      networkAccess: false,
      shellAccess: false,
    },
    ...overrides,
  }
}

function createMockAnthropicStream(opts: { textContent: string; stopReason: string }) {
  const events: unknown[] = []
  if (opts.textContent) {
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: opts.textContent },
    })
  }
  const finalMsg = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: opts.textContent ? [{ type: "text", text: opts.textContent }] : [],
    model: "test",
    stop_reason: opts.stopReason,
    usage: { input_tokens: 10, output_tokens: 20 },
  }
  let eventIndex = 0
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (eventIndex < events.length) {
            return Promise.resolve({ value: events[eventIndex++], done: false as const })
          }
          return Promise.resolve({ value: undefined, done: true as const })
        },
      }
    },
    finalMessage: () => Promise.resolve(finalMsg),
    abort: vi.fn(),
  }
}

async function collectEvents(handle: { events(): AsyncIterable<OutputEvent> }) {
  const events: OutputEvent[] = []
  for await (const e of handle.events()) {
    events.push(e)
  }
  return events
}

// ---------------------------------------------------------------------------
// Part A: LLM credential injection
// ---------------------------------------------------------------------------

describe("LLM credential injection", () => {
  it("uses per-job credential when llmCredential is set on task.constraints", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "per-job-token-abc",
          credentialId: "cred-123",
        },
      },
    })

    // Get the handle — it should be created with a one-shot client
    const handle = await backend.executeTask(task)
    expect(handle.taskId).toBe("task-cred-001")

    // Cancel to clean up (we don't actually want to call the API)
    await handle.cancel("test")
    const result = await handle.result()
    expect(result.status).toBe("cancelled")
  })

  it("creates Anthropic client for anthropic provider credential", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "openai", apiKey: "global-openai-key", model: "gpt-4o" })

    // Even though backend is configured for OpenAI, a per-job anthropic credential
    // should create an Anthropic client
    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "anthropic-per-job",
          credentialId: "cred-456",
        },
      },
    })

    const handle = await backend.executeTask(task)
    // The handle should be an AnthropicHandle (not OpenAIHandle)
    // We verify by checking the task was accepted
    expect(handle.taskId).toBe("task-cred-001")
    await handle.cancel("test")
  })

  it("creates OpenAI client for openai provider credential", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-anthropic-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "openai",
          token: "openai-per-job",
          credentialId: "cred-789",
        },
      },
    })

    const handle = await backend.executeTask(task)
    expect(handle.taskId).toBe("task-cred-001")
    await handle.cancel("test")
  })

  it("creates Anthropic client for google-antigravity provider", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "openai", apiKey: "global-key", model: "gpt-4o" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "google-antigravity",
          token: "goog-token",
          credentialId: "cred-goog",
        },
      },
    })

    const handle = await backend.executeTask(task)
    expect(handle.taskId).toBe("task-cred-001")
    await handle.cancel("test")
  })

  it("uses x-api-key (apiKey) for Anthropic OAuth credentials (not Bearer)", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "oauth-access-token",
          credentialId: "cred-oauth",
          credentialType: "oauth",
        },
      },
    })

    const handle = await backend.executeTask(task)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const useAuthToken = (handle as any).useAuthToken
    expect(useAuthToken).toBe(false)
    await handle.cancel("test")
  })

  it("uses x-api-key (apiKey) for Anthropic api_key credentials", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "sk-ant-api-key",
          credentialId: "cred-apikey",
          credentialType: "api_key",
        },
      },
    })

    const handle = await backend.executeTask(task)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const useAuthToken = (handle as any).useAuthToken
    expect(useAuthToken).toBe(false)
    await handle.cancel("test")
  })

  it("uses Bearer auth (authToken) for google-antigravity even without credentialType", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "google-antigravity",
          token: "goog-oauth-token",
          credentialId: "cred-goog-2",
          // No credentialType — Antigravity always uses Bearer
        },
      },
    })

    const handle = await backend.executeTask(task)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const useAuthToken = (handle as any).useAuthToken
    expect(useAuthToken).toBe(true)
    await handle.cancel("test")
  })

  it("falls back to global client when no llmCredential is set", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const client = (backend as any).anthropicClient

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    vi.spyOn(client.messages, "stream").mockImplementation(() => {
      return createMockAnthropicStream({
        textContent: "Hello from global key",
        stopReason: "end_turn",
      })
    })

    const task = makeTask() // No llmCredential
    const handle = await backend.executeTask(task)
    await collectEvents(handle)

    const result = await handle.result()
    expect(result.status).toBe("completed")
    expect(result.stdout).toBe("Hello from global key")
  })

  it("per-job credential creates an isolated client for the API call", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: "per-job-token",
          credentialId: "cred-iso",
        },
      },
    })

    // The per-job handle uses its own client, not the backend's global client
    const handle = await backend.executeTask(task)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const handleClient = (handle as any).client

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const globalClient = (backend as any).anthropicClient

    // They should be different client instances
    expect(handleClient).not.toBe(globalClient)
    await handle.cancel("test")
  })
})

// ---------------------------------------------------------------------------
// Part B: Tool credential injection (webhook tools)
// ---------------------------------------------------------------------------

describe("Webhook tool credential injection", () => {
  it("injects resolved credentials as headers when injectAs=header", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }))

    const resolver: CredentialResolver = vi.fn().mockResolvedValue({
      key: "Authorization",
      value: "Bearer test-token-123",
    })

    const spec: WebhookToolSpec = {
      name: "my_api",
      description: "Call external API",
      inputSchema: { type: "object", properties: {} },
      webhook: { url: "https://api.example.com/data" },
      credentials: [
        {
          credentialClass: "user_service",
          provider: "github-user",
          injectAs: "header",
          headerName: "Authorization",
          format: "bearer",
        },
      ],
    }

    const tool = createWebhookTool(spec, resolver)
    const result = await tool.execute({})

    expect(result).toBe("ok")
    expect(resolver).toHaveBeenCalledWith(spec.credentials![0])

    // Verify the fetch was called with the injected Authorization header
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.example.com/data",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token-123",
        }) as Record<string, string>,
      }),
    )

    fetchSpy.mockRestore()
  })

  it("returns error when credential resolution fails", async () => {
    const resolver: CredentialResolver = vi.fn().mockResolvedValue(null)

    const spec: WebhookToolSpec = {
      name: "secured_api",
      description: "Needs credentials",
      inputSchema: { type: "object", properties: {} },
      webhook: { url: "https://api.example.com/secure" },
      credentials: [
        {
          credentialClass: "tool_specific",
          provider: "brave",
          injectAs: "header",
          headerName: "X-API-Key",
        },
      ],
    }

    const tool = createWebhookTool(spec, resolver)
    const result = await tool.execute({})

    // Should return error JSON, NOT throw
    const parsed = JSON.parse(result) as { error: string; tool: string }
    expect(parsed.error).toContain("Failed to resolve credential")
    expect(parsed.error).toContain("brave")
    expect(parsed.tool).toBe("secured_api")
  })

  it("does not inject credentials when no resolver is provided", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("no-auth-response", { status: 200 }))

    const spec: WebhookToolSpec = {
      name: "open_api",
      description: "No auth needed",
      inputSchema: { type: "object", properties: {} },
      webhook: { url: "https://api.example.com/open" },
      credentials: [
        {
          credentialClass: "user_service",
          provider: "github-user",
          injectAs: "header",
          headerName: "Authorization",
          format: "bearer",
        },
      ],
    }

    // No resolver passed — credentials are ignored
    const tool = createWebhookTool(spec)
    const result = await tool.execute({})

    expect(result).toBe("no-auth-response")

    // Fetch should be called without Authorization header
    const fetchCall = fetchSpy.mock.calls[0]
    const headers = (fetchCall[1] as RequestInit).headers as Record<string, string>
    expect(headers).not.toHaveProperty("Authorization")

    fetchSpy.mockRestore()
  })

  it("injects multiple credentials", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("multi-auth", { status: 200 }))

    const resolver = vi.fn<CredentialResolver>().mockImplementation((ref) => {
      if (ref.provider === "github-user") {
        return Promise.resolve({ key: "Authorization", value: "Bearer gh-token" })
      }
      if (ref.provider === "brave") {
        return Promise.resolve({ key: "X-Subscription-Token", value: "brave-key-123" })
      }
      return Promise.resolve(null)
    })

    const spec: WebhookToolSpec = {
      name: "multi_auth_api",
      description: "Needs multiple creds",
      inputSchema: { type: "object", properties: {} },
      webhook: { url: "https://api.example.com/multi" },
      credentials: [
        {
          credentialClass: "user_service",
          provider: "github-user",
          injectAs: "header",
          headerName: "Authorization",
          format: "bearer",
        },
        {
          credentialClass: "tool_specific",
          provider: "brave",
          injectAs: "header",
          headerName: "X-Subscription-Token",
        },
      ],
    }

    const tool = createWebhookTool(spec, resolver)
    await tool.execute({})

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.example.com/multi",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer gh-token",
          "X-Subscription-Token": "brave-key-123",
        }) as Record<string, string>,
      }),
    )

    fetchSpy.mockRestore()
  })

  it("fails individual tool call on missing credential, not the entire job", async () => {
    const resolver: CredentialResolver = vi.fn().mockResolvedValue(null)

    const spec: WebhookToolSpec = {
      name: "failing_cred_tool",
      description: "Has unresolvable cred",
      inputSchema: { type: "object", properties: {} },
      webhook: { url: "https://api.example.com/fail" },
      credentials: [
        {
          credentialClass: "user_service",
          provider: "nonexistent-provider",
          injectAs: "header",
          headerName: "Authorization",
          format: "bearer",
        },
      ],
    }

    const tool = createWebhookTool(spec, resolver)

    // Should NOT throw (that would fail the job) — should return error string
    const result = await tool.execute({})
    const parsed: { error: string } = JSON.parse(result) as { error: string }
    expect(parsed.error).toContain("nonexistent-provider")
  })
})

// ---------------------------------------------------------------------------
// parseWebhookTools — credential parsing
// ---------------------------------------------------------------------------

describe("parseWebhookTools — credential refs", () => {
  it("parses credentials[] from agent config", () => {
    const config = {
      tools: [
        {
          name: "github_api",
          description: "Call GitHub API",
          inputSchema: { type: "object", properties: {} },
          webhook: { url: "https://api.github.com/repos" },
          credentials: [
            {
              credentialClass: "user_service",
              provider: "github-user",
              injectAs: "header",
              headerName: "Authorization",
              format: "bearer",
            },
          ],
        },
      ],
    }

    const specs = parseWebhookTools(config)
    expect(specs).toHaveLength(1)
    expect(specs[0].credentials).toHaveLength(1)
    expect(specs[0].credentials![0]).toEqual({
      credentialClass: "user_service",
      provider: "github-user",
      injectAs: "header",
      headerName: "Authorization",
      format: "bearer",
    })
  })

  it("omits credentials when not specified", () => {
    const config = {
      tools: [
        {
          name: "simple_hook",
          description: "No credentials",
          inputSchema: { type: "object", properties: {} },
          webhook: { url: "https://example.com/hook" },
        },
      ],
    }

    const specs = parseWebhookTools(config)
    expect(specs).toHaveLength(1)
    expect(specs[0].credentials).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// createAgentToolRegistry — credential resolver passthrough
// ---------------------------------------------------------------------------

describe("createAgentToolRegistry — credential resolver", () => {
  it("passes credential resolver to webhook tools", async () => {
    const resolver: CredentialResolver = vi.fn().mockResolvedValue({
      key: "Authorization",
      value: "Bearer resolved-token",
    })

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("authed-response", { status: 200 }))

    const registry = await createAgentToolRegistry(
      {
        tools: [
          {
            name: "cred_hook",
            description: "Hook with creds",
            inputSchema: { type: "object", properties: {} },
            webhook: { url: "https://api.example.com/data" },
            credentials: [
              {
                credentialClass: "user_service",
                provider: "github-user",
                injectAs: "header",
                headerName: "Authorization",
                format: "bearer",
              },
            ],
          },
        ],
      },
      { credentialResolver: resolver },
    )

    const tool = registry.get("cred_hook")
    expect(tool).toBeDefined()

    const { output, isError } = await registry.execute("cred_hook", {})
    expect(isError).toBe(false)
    expect(output).toBe("authed-response")
    expect(resolver).toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it("works without credential resolver (backward compat)", async () => {
    const registry = await createAgentToolRegistry({
      tools: [
        {
          name: "plain_hook",
          description: "No creds",
          inputSchema: { type: "object", properties: {} },
          webhook: { url: "https://api.example.com/plain" },
        },
      ],
    })

    expect(registry.get("plain_hook")).toBeDefined()
    expect(registry.get("echo")).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Part C: Security — token not in results
// ---------------------------------------------------------------------------

describe("Credential security", () => {
  it("llmCredential token does not appear in execution result", async () => {
    const backend = new HttpLlmBackend()
    await backend.start({ provider: "anthropic", apiKey: "global-key" })

    const secretToken = "sk-super-secret-never-log-this"

    const task = makeTask({
      constraints: {
        ...makeTask().constraints,
        llmCredential: {
          provider: "anthropic",
          token: secretToken,
          credentialId: "cred-sec",
        },
      },
    })

    const handle = await backend.executeTask(task)
    await handle.cancel("security test")

    const result = await handle.result()

    // Token must NOT appear anywhere in the result
    const resultStr = JSON.stringify(result)
    expect(resultStr).not.toContain(secretToken)
  })
})
