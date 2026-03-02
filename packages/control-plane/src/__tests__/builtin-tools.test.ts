import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest"

import { createAgentToolRegistry, createDefaultToolRegistry } from "../backends/tool-executor.js"
import { createHttpRequestTool } from "../backends/tools/http-request.js"
import { createMemoryQueryTool } from "../backends/tools/memory-query.js"
import { createMemoryStoreTool } from "../backends/tools/memory-store.js"
import { createWebSearchTool } from "../backends/tools/web-search.js"
import {
  createWebhookTool,
  parseWebhookTools,
  type WebhookToolSpec,
} from "../backends/tools/webhook.js"

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

let fetchMock: MockInstance

beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, "fetch")
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetchResponse(body: unknown, status = 200, statusText = "OK"): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      statusText,
      headers: { "Content-Type": "application/json" },
    }),
  )
}

function mockFetchTextResponse(body: string, status = 200, statusText = "OK"): void {
  fetchMock.mockResolvedValueOnce(
    new Response(body, {
      status,
      statusText,
      headers: { "Content-Type": "text/plain" },
    }),
  )
}

/** Parse JSON tool output with a typed result. */
function parseResult(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>
}

/** Parse a request body from fetch mock args. */
function parseBody(opts: RequestInit): Record<string, unknown> {
  return JSON.parse(opts.body as string) as Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════════════════
// web_search
// ═══════════════════════════════════════════════════════════════════════════

describe("web_search tool", () => {
  it("has correct name and schema", () => {
    const tool = createWebSearchTool({ apiKey: "test-key" })
    expect(tool.name).toBe("web_search")
    expect(tool.inputSchema.required).toContain("query")
  })

  it("returns error when no API key is configured", async () => {
    const tool = createWebSearchTool({ apiKey: "" })
    const result = await tool.execute({ query: "test" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("not configured")
  })

  it("makes a GET request to the search API", async () => {
    mockFetchResponse({
      web: {
        results: [
          { title: "Result 1", url: "https://example.com/1", description: "Desc 1" },
          { title: "Result 2", url: "https://example.com/2", description: "Desc 2" },
        ],
      },
    })

    const tool = createWebSearchTool({ apiKey: "test-key" })
    const result = await tool.execute({ query: "hello world" })
    const parsed = parseResult(result)

    expect(parsed.results).toHaveLength(2)
    expect((parsed.results as Record<string, unknown>[])[0].title).toBe("Result 1")
    expect(parsed.query).toBe("hello world")

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("q=hello+world")
    expect(opts.method).toBe("GET")
    expect((opts.headers as Record<string, string>)["X-Subscription-Token"]).toBe("test-key")
  })

  it("respects count parameter", async () => {
    mockFetchResponse({
      web: {
        results: [
          { title: "R1", url: "https://a.com", description: "D1" },
          { title: "R2", url: "https://b.com", description: "D2" },
          { title: "R3", url: "https://c.com", description: "D3" },
        ],
      },
    })

    const tool = createWebSearchTool({ apiKey: "test-key" })
    const result = await tool.execute({ query: "test", count: 2 })
    const parsed = parseResult(result)

    expect(parsed.results).toHaveLength(2)
  })

  it("caps count at 20", async () => {
    mockFetchResponse({ web: { results: [] } })

    const tool = createWebSearchTool({ apiKey: "test-key" })
    await tool.execute({ query: "test", count: 100 })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain("count=20")
  })

  it("handles API error responses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
    )

    const tool = createWebSearchTool({ apiKey: "test-key" })
    const result = await tool.execute({ query: "test" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("403")
  })

  it("handles missing web results gracefully", async () => {
    mockFetchResponse({ query: { original: "test" } })

    const tool = createWebSearchTool({ apiKey: "test-key" })
    const result = await tool.execute({ query: "test" })
    const parsed = parseResult(result)
    expect(parsed.results).toEqual([])
  })

  it("uses custom API URL", async () => {
    mockFetchResponse({ web: { results: [] } })

    const tool = createWebSearchTool({
      apiKey: "key",
      apiUrl: "https://custom-search.example.com/search",
    })
    await tool.execute({ query: "test" })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain("custom-search.example.com")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// memory_query
// ═══════════════════════════════════════════════════════════════════════════

describe("memory_query tool", () => {
  it("has correct name and schema", () => {
    const tool = createMemoryQueryTool()
    expect(tool.name).toBe("memory_query")
    expect(tool.inputSchema.required).toContain("query")
  })

  it("queries Qdrant scroll endpoint", async () => {
    mockFetchResponse({
      result: {
        points: [
          { id: "p1", payload: { content: "Memory 1", metadata: { topic: "arch" } } },
          { id: "p2", payload: { content: "Memory 2", metadata: {} } },
        ],
      },
    })

    const tool = createMemoryQueryTool({ qdrantUrl: "http://qdrant:6333" })
    const result = await tool.execute({ query: "architecture" })
    const parsed = parseResult(result)

    expect(parsed.memories).toHaveLength(2)
    expect((parsed.memories as Record<string, unknown>[])[0].content).toBe("Memory 1")
    expect(parsed.count).toBe(2)

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain("qdrant:6333/collections/agent_memories/points/scroll")
  })

  it("passes limit parameter", async () => {
    mockFetchResponse({ result: { points: [] } })

    const tool = createMemoryQueryTool()
    await tool.execute({ query: "test", limit: 3 })

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = parseBody(opts)
    expect(body.limit).toBe(3)
  })

  it("caps limit at 50", async () => {
    mockFetchResponse({ result: { points: [] } })

    const tool = createMemoryQueryTool()
    await tool.execute({ query: "test", limit: 100 })

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = parseBody(opts)
    expect(body.limit).toBe(50)
  })

  it("passes filter to Qdrant", async () => {
    mockFetchResponse({ result: { points: [] } })

    const tool = createMemoryQueryTool()
    await tool.execute({ query: "test", filter: { agentId: "agent-1" } })

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = parseBody(opts)
    const filter = body.filter as Record<string, unknown>
    const must = filter.must as Record<string, unknown>[]
    expect(must[0].key).toBe("agentId")
    expect((must[0].match as Record<string, unknown>).value).toBe("agent-1")
  })

  it("handles API errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    )

    const tool = createMemoryQueryTool()
    const result = await tool.execute({ query: "test" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("404")
  })

  it("handles empty points array", async () => {
    mockFetchResponse({ result: { points: [] } })

    const tool = createMemoryQueryTool()
    const result = await tool.execute({ query: "test" })
    const parsed = parseResult(result)
    expect(parsed.memories).toEqual([])
    expect(parsed.count).toBe(0)
  })

  it("sends API key header when configured", async () => {
    mockFetchResponse({ result: { points: [] } })

    const tool = createMemoryQueryTool({ qdrantApiKey: "my-key" })
    await tool.execute({ query: "test" })

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)["api-key"]).toBe("my-key")
  })

  it("uses custom collection name", async () => {
    mockFetchResponse({ result: { points: [] } })

    const tool = createMemoryQueryTool({ collection: "custom_memories" })
    await tool.execute({ query: "test" })

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toContain("custom_memories")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// memory_store
// ═══════════════════════════════════════════════════════════════════════════

describe("memory_store tool", () => {
  it("has correct name and schema", () => {
    const tool = createMemoryStoreTool()
    expect(tool.name).toBe("memory_store")
    expect(tool.inputSchema.required).toContain("content")
  })

  it("stores a memory point in Qdrant", async () => {
    mockFetchResponse({ status: "ok" })

    const tool = createMemoryStoreTool({ qdrantUrl: "http://qdrant:6333" })
    const result = await tool.execute({ content: "Important fact about architecture" })
    const parsed = parseResult(result)

    expect(parsed.stored).toBe(true)
    expect(parsed.id).toBeDefined()

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("qdrant:6333/collections/agent_memories/points")
    expect(opts.method).toBe("PUT")

    const body = parseBody(opts)
    const points = body.points as Record<string, unknown>[]
    expect(points).toHaveLength(1)
    expect((points[0].payload as Record<string, unknown>).content).toBe(
      "Important fact about architecture",
    )
  })

  it("includes metadata in stored point", async () => {
    mockFetchResponse({ status: "ok" })

    const tool = createMemoryStoreTool()
    await tool.execute({
      content: "Some fact",
      metadata: { topic: "design", importance: "high" },
    })

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = parseBody(opts)
    const points = body.points as Record<string, unknown>[]
    expect((points[0].payload as Record<string, unknown>).metadata).toEqual({
      topic: "design",
      importance: "high",
    })
  })

  it("uses correct vector size", async () => {
    mockFetchResponse({ status: "ok" })

    const tool = createMemoryStoreTool({ vectorSize: 768 })
    await tool.execute({ content: "test" })

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = parseBody(opts)
    const points = body.points as Record<string, unknown>[]
    expect(points[0].vector).toHaveLength(768)
  })

  it("truncates content in response for long inputs", async () => {
    mockFetchResponse({ status: "ok" })

    const longContent = "A".repeat(200)
    const tool = createMemoryStoreTool()
    const result = await tool.execute({ content: longContent })
    const parsed = parseResult(result)

    expect(parsed.content).toContain("...")
    expect((parsed.content as string).length).toBeLessThan(200)
  })

  it("handles API errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Error", { status: 500, statusText: "Internal Server Error" }),
    )

    const tool = createMemoryStoreTool()
    const result = await tool.execute({ content: "test" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("500")
  })

  it("sends API key header when configured", async () => {
    mockFetchResponse({ status: "ok" })

    const tool = createMemoryStoreTool({ qdrantApiKey: "qdrant-key" })
    await tool.execute({ content: "test" })

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((opts.headers as Record<string, string>)["api-key"]).toBe("qdrant-key")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// http_request
// ═══════════════════════════════════════════════════════════════════════════

describe("http_request tool", () => {
  it("has correct name and schema", () => {
    const tool = createHttpRequestTool()
    expect(tool.name).toBe("http_request")
    expect(tool.inputSchema.required).toContain("url")
  })

  it("makes a GET request by default", async () => {
    mockFetchTextResponse("Hello, World!")

    const tool = createHttpRequestTool()
    const result = await tool.execute({ url: "https://example.com/api" })
    const parsed = parseResult(result)

    expect(parsed.status).toBe(200)
    expect(parsed.body).toBe("Hello, World!")

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://example.com/api")
    expect(opts.method).toBe("GET")
  })

  it("makes a POST request with body", async () => {
    mockFetchResponse({ success: true })

    const tool = createHttpRequestTool()
    const result = await tool.execute({
      url: "https://example.com/api",
      method: "POST",
      body: '{"key": "value"}',
      headers: { "Content-Type": "application/json" },
    })

    const parsed = parseResult(result)
    expect(parsed.status).toBe(200)

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(opts.method).toBe("POST")
    expect(opts.body).toBe('{"key": "value"}')
  })

  it("blocks requests to localhost", async () => {
    const tool = createHttpRequestTool()
    const result = await tool.execute({ url: "http://localhost:8080/secret" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("not allowed")
  })

  it("blocks requests to 127.0.0.1", async () => {
    const tool = createHttpRequestTool()
    const result = await tool.execute({ url: "http://127.0.0.1:8080/secret" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("not allowed")
  })

  it("blocks requests to ::1", async () => {
    const tool = createHttpRequestTool()
    const result = await tool.execute({ url: "http://[::1]:8080/secret" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("not allowed")
  })

  it("blocks requests to 0.0.0.0", async () => {
    const tool = createHttpRequestTool()
    const result = await tool.execute({ url: "http://0.0.0.0:8080/secret" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("not allowed")
  })

  it("blocks requests to .internal domains", async () => {
    const tool = createHttpRequestTool()
    const result = await tool.execute({ url: "http://service.internal:8080/api" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("not allowed")
  })

  it("rejects invalid URLs", async () => {
    const tool = createHttpRequestTool()
    const result = await tool.execute({ url: "not-a-url" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("Invalid URL")
  })

  it("rejects unsupported HTTP methods", async () => {
    const tool = createHttpRequestTool()
    const result = await tool.execute({ url: "https://example.com", method: "TRACE" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("Unsupported HTTP method")
  })

  it("respects URL allowlist", async () => {
    const tool = createHttpRequestTool({
      allowedUrlPrefixes: ["https://api.example.com/"],
    })

    const result = await tool.execute({ url: "https://evil.com/steal" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("not in the allowed list")
  })

  it("allows URLs matching the allowlist", async () => {
    mockFetchTextResponse("OK")

    const tool = createHttpRequestTool({
      allowedUrlPrefixes: ["https://api.example.com/"],
    })

    const result = await tool.execute({ url: "https://api.example.com/data" })
    const parsed = parseResult(result)
    expect(parsed.status).toBe(200)
  })

  it("handles response size limit", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("x".repeat(100), {
        status: 200,
        headers: { "Content-Length": "2000000" },
      }),
    )

    const tool = createHttpRequestTool({ maxResponseBytes: 1_048_576 })
    const result = await tool.execute({ url: "https://example.com/large" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("too large")
  })

  it("supports all standard HTTP methods", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      fetchMock.mockResolvedValueOnce(new Response("ok", { status: 200 }))
      const tool = createHttpRequestTool()
      const result = await tool.execute({ url: "https://example.com", method })
      const parsed = parseResult(result)
      expect(parsed.status).toBe(200)
    }
  })

  it("does not send body for GET requests", async () => {
    mockFetchTextResponse("ok")

    const tool = createHttpRequestTool()
    await tool.execute({ url: "https://example.com", method: "GET", body: "ignored" })

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(opts.body).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// webhook tools
// ═══════════════════════════════════════════════════════════════════════════

describe("createWebhookTool", () => {
  const spec: WebhookToolSpec = {
    name: "my_webhook",
    description: "Calls my webhook",
    inputSchema: {
      type: "object",
      properties: { data: { type: "string" } },
      required: ["data"],
    },
    webhook: {
      url: "https://hooks.example.com/trigger",
      method: "POST",
      headers: { Authorization: "Bearer token123" },
      timeout_ms: 5000,
    },
  }

  it("creates a tool with the correct name and schema", () => {
    const tool = createWebhookTool(spec)
    expect(tool.name).toBe("my_webhook")
    expect(tool.description).toBe("Calls my webhook")
    expect(tool.inputSchema).toEqual(spec.inputSchema)
  })

  it("sends input as JSON body to the webhook URL", async () => {
    mockFetchTextResponse('{"result": "ok"}')

    const tool = createWebhookTool(spec)
    const result = await tool.execute({ data: "hello" })

    expect(result).toBe('{"result": "ok"}')

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://hooks.example.com/trigger")
    expect(opts.method).toBe("POST")
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer token123")

    const body = parseBody(opts)
    expect(body.data).toBe("hello")
  })

  it("handles webhook error responses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Error", { status: 500, statusText: "Internal Server Error" }),
    )

    const tool = createWebhookTool(spec)
    const result = await tool.execute({ data: "test" })
    const parsed = parseResult(result)
    expect(parsed.error).toContain("500")
  })

  it("defaults to POST method", () => {
    const specNoMethod: WebhookToolSpec = {
      ...spec,
      webhook: { url: "https://hooks.example.com/trigger" },
    }
    const tool = createWebhookTool(specNoMethod)

    expect(tool.name).toBe("my_webhook")
  })

  it("uses GET method when specified", async () => {
    mockFetchTextResponse("result")

    const getSpec: WebhookToolSpec = {
      ...spec,
      webhook: { ...spec.webhook, method: "GET" },
    }
    const tool = createWebhookTool(getSpec)
    await tool.execute({ data: "test" })

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(opts.method).toBe("GET")
    expect(opts.body).toBeUndefined()
  })
})

describe("parseWebhookTools", () => {
  it("returns empty array when no tools configured", () => {
    expect(parseWebhookTools({})).toEqual([])
    expect(parseWebhookTools({ tools: "not-an-array" })).toEqual([])
  })

  it("parses valid webhook tool specs", () => {
    const config = {
      tools: [
        {
          name: "tool_a",
          description: "Tool A",
          inputSchema: { type: "object", properties: {} },
          webhook: { url: "https://a.example.com" },
        },
        {
          name: "tool_b",
          description: "Tool B",
          inputSchema: { type: "object", properties: {} },
          webhook: {
            url: "https://b.example.com",
            method: "PUT",
            headers: { "X-Custom": "value" },
            timeout_ms: 10_000,
          },
        },
      ],
    }

    const specs = parseWebhookTools(config)
    expect(specs).toHaveLength(2)
    expect(specs[0].name).toBe("tool_a")
    expect(specs[1].webhook.method).toBe("PUT")
    expect(specs[1].webhook.headers).toEqual({ "X-Custom": "value" })
  })

  it("skips invalid entries", () => {
    const config = {
      tools: [
        {
          name: "valid",
          description: "Valid",
          inputSchema: {},
          webhook: { url: "https://x.com" },
        },
        { name: "missing_webhook" },
        { name: "bad_url", description: "Bad", inputSchema: {}, webhook: { url: 123 } },
        null,
        "not-an-object",
        { description: "no name", inputSchema: {}, webhook: { url: "https://x.com" } },
      ],
    }

    const specs = parseWebhookTools(config)
    expect(specs).toHaveLength(1)
    expect(specs[0].name).toBe("valid")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// createDefaultToolRegistry — now includes built-in tools
// ═══════════════════════════════════════════════════════════════════════════

describe("createDefaultToolRegistry — built-in tools", () => {
  it("includes echo tool", () => {
    const registry = createDefaultToolRegistry()
    expect(registry.get("echo")).toBeDefined()
  })

  it("includes web_search tool", () => {
    const registry = createDefaultToolRegistry()
    expect(registry.get("web_search")).toBeDefined()
  })

  it("includes memory_query tool", () => {
    const registry = createDefaultToolRegistry()
    expect(registry.get("memory_query")).toBeDefined()
  })

  it("includes memory_store tool", () => {
    const registry = createDefaultToolRegistry()
    expect(registry.get("memory_store")).toBeDefined()
  })

  it("includes http_request tool", () => {
    const registry = createDefaultToolRegistry()
    expect(registry.get("http_request")).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// createAgentToolRegistry
// ═══════════════════════════════════════════════════════════════════════════

describe("createAgentToolRegistry", () => {
  it("includes all default tools when no custom tools configured", () => {
    const registry = createAgentToolRegistry({})
    expect(registry.get("echo")).toBeDefined()
    expect(registry.get("web_search")).toBeDefined()
    expect(registry.get("memory_query")).toBeDefined()
    expect(registry.get("memory_store")).toBeDefined()
    expect(registry.get("http_request")).toBeDefined()
  })

  it("registers custom webhook tools from agent config", () => {
    const registry = createAgentToolRegistry({
      tools: [
        {
          name: "custom_tool",
          description: "Custom webhook tool",
          inputSchema: { type: "object", properties: {} },
          webhook: { url: "https://hooks.example.com/custom" },
        },
      ],
    })

    expect(registry.get("custom_tool")).toBeDefined()
    expect(registry.get("custom_tool")!.description).toBe("Custom webhook tool")
  })

  it("includes both default and custom tools", () => {
    const registry = createAgentToolRegistry({
      tools: [
        {
          name: "agent_tool",
          description: "Agent-specific tool",
          inputSchema: { type: "object", properties: {} },
          webhook: { url: "https://hooks.example.com" },
        },
      ],
    })

    expect(registry.get("echo")).toBeDefined()
    expect(registry.get("web_search")).toBeDefined()
    expect(registry.get("agent_tool")).toBeDefined()
  })

  it("resolves custom tools via allowed list", () => {
    const registry = createAgentToolRegistry({
      tools: [
        {
          name: "agent_tool",
          description: "Agent-specific tool",
          inputSchema: { type: "object", properties: {} },
          webhook: { url: "https://hooks.example.com" },
        },
      ],
    })

    const resolved = registry.resolve(["echo", "agent_tool"], [])
    expect(resolved).toHaveLength(2)
    expect(resolved.map((t) => t.name)).toContain("agent_tool")
  })

  it("custom tools can be denied", () => {
    const registry = createAgentToolRegistry({
      tools: [
        {
          name: "agent_tool",
          description: "Agent-specific tool",
          inputSchema: { type: "object", properties: {} },
          webhook: { url: "https://hooks.example.com" },
        },
      ],
    })

    const resolved = registry.resolve(["echo", "agent_tool"], ["agent_tool"])
    expect(resolved).toHaveLength(1)
    expect(resolved[0].name).toBe("echo")
  })
})
