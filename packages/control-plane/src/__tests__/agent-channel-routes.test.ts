import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"

import type { AgentChannelService } from "../channels/agent-channel-service.js"
import type { AuthConfig } from "../middleware/types.js"
import { agentChannelRoutes } from "../routes/agent-channels.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

function makeBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "bbbbbbbb-1111-2222-3333-444444444444",
    agent_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    channel_type: "telegram",
    chat_id: "12345",
    is_default: false,
    created_at: new Date(),
    ...overrides,
  }
}

function mockService(overrides: Partial<AgentChannelService> = {}): AgentChannelService {
  return {
    resolveAgent: vi.fn().mockResolvedValue("agent-id"),
    bindChannel: vi.fn().mockResolvedValue(undefined),
    unbindChannel: vi.fn().mockResolvedValue(undefined),
    unbindById: vi.fn().mockResolvedValue(true),
    listBindings: vi.fn().mockResolvedValue([makeBinding()]),
    setDefault: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AgentChannelService
}

async function buildTestApp(serviceOverrides: Partial<AgentChannelService> = {}) {
  const app = Fastify({ logger: false })
  const service = mockService(serviceOverrides)

  await app.register(agentChannelRoutes({ service, authConfig: DEV_AUTH_CONFIG }))

  return { app, service }
}

// ---------------------------------------------------------------------------
// Tests: GET /agents/:agentId/channels
// ---------------------------------------------------------------------------

describe("GET /agents/:agentId/channels", () => {
  it("returns list of bindings", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/channels",
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.bindings).toBeDefined()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.bindings).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/channels
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/channels", () => {
  it("binds a channel", async () => {
    const { app, service } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/channels",
      payload: {
        channel_type: "telegram",
        chat_id: "12345",
      },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.bindChannel).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "telegram",
      "12345",
    )
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.status).toBe("bound")
  })

  it("validates required fields", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/channels",
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /agents/:agentId/channels/:bindingId
// ---------------------------------------------------------------------------

describe("DELETE /agents/:agentId/channels/:bindingId", () => {
  it("unbinds a channel", async () => {
    const { app, service } = await buildTestApp()

    const res = await app.inject({
      method: "DELETE",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/channels/bbbbbbbb-1111-2222-3333-444444444444",
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.unbindById).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "bbbbbbbb-1111-2222-3333-444444444444",
    )
  })

  it("returns 404 when binding not found", async () => {
    const { app } = await buildTestApp({
      unbindById: vi.fn().mockResolvedValue(false),
    })

    const res = await app.inject({
      method: "DELETE",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/channels/nonexistent",
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /agents/:agentId/channels/default
// ---------------------------------------------------------------------------

describe("POST /agents/:agentId/channels/default", () => {
  it("sets default agent for channel type", async () => {
    const { app, service } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/channels/default",
      payload: { channel_type: "telegram" },
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.setDefault).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "telegram",
    )
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.is_default).toBe(true)
  })

  it("validates required channel_type", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/agents/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/channels/default",
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})
