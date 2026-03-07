import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"

import type { ChannelConfigService } from "../channels/channel-config-service.js"
import type { AuthConfig } from "../middleware/types.js"
import { channelRoutes } from "../routes/channels.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "cccccccc-1111-2222-3333-444444444444",
    type: "telegram",
    name: "My Telegram Bot",
    enabled: true,
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function mockService(overrides: Partial<ChannelConfigService> = {}): ChannelConfigService {
  return {
    list: vi.fn().mockResolvedValue([makeSummary()]),
    getById: vi.fn().mockResolvedValue(makeSummary()),
    getByIdFull: vi.fn().mockResolvedValue(undefined),
    listEnabled: vi.fn().mockResolvedValue([]),
    findByTypeName: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(makeSummary()),
    update: vi.fn().mockResolvedValue(makeSummary()),
    delete: vi.fn().mockResolvedValue(true),
    getBindingsByChannelType: vi.fn().mockResolvedValue([]),
    removeBindingsByChannelType: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as ChannelConfigService
}

async function buildTestApp(serviceOverrides: Partial<ChannelConfigService> = {}) {
  const app = Fastify({ logger: false })
  const service = mockService(serviceOverrides)

  await app.register(channelRoutes({ service, authConfig: DEV_AUTH_CONFIG }))

  return { app, service }
}

// ---------------------------------------------------------------------------
// Tests: POST /channels — duplicate detection
// ---------------------------------------------------------------------------

describe("POST /channels — duplicate detection", () => {
  it("returns 409 when a channel with the same type+name exists", async () => {
    const { app } = await buildTestApp({
      findByTypeName: vi.fn().mockResolvedValue(makeSummary()),
    })

    const res = await app.inject({
      method: "POST",
      url: "/channels",
      payload: { type: "telegram", name: "My Telegram Bot", config: { botToken: "tok" } },
    })

    expect(res.statusCode).toBe(409)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.error).toBe("conflict")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.message).toContain("already exists")
  })

  it("creates channel when no duplicate exists", async () => {
    const { app, service } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/channels",
      payload: { type: "telegram", name: "New Bot", config: { botToken: "tok" } },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.create).toHaveBeenCalled()
  })

  it("allows same name for different channel types", async () => {
    const { app, service } = await buildTestApp({
      // findByTypeName returns undefined = no match for the queried type+name
      findByTypeName: vi.fn().mockResolvedValue(undefined),
    })

    const res = await app.inject({
      method: "POST",
      url: "/channels",
      payload: { type: "discord", name: "My Telegram Bot", config: { token: "tok" } },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.create).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /channels/:id — binding safety check
// ---------------------------------------------------------------------------

describe("DELETE /channels/:id — binding safety check", () => {
  it("returns 409 when channel has active agent bindings", async () => {
    const bindings = [
      { agent_id: "aaaa-1111", chat_id: "chat-1" },
      { agent_id: "aaaa-2222", chat_id: "chat-2" },
    ]
    const { app } = await buildTestApp({
      getById: vi.fn().mockResolvedValue(makeSummary()),
      getBindingsByChannelType: vi.fn().mockResolvedValue(bindings),
    })

    const res = await app.inject({
      method: "DELETE",
      url: "/channels/cccccccc-1111-2222-3333-444444444444",
    })

    expect(res.statusCode).toBe(409)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.error).toBe("conflict")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.message).toContain("agent(s) bound")
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.bound_agents).toEqual(["aaaa-1111", "aaaa-2222"])
  })

  it("returns 200 when channel has no bindings", async () => {
    const { app, service } = await buildTestApp({
      getById: vi.fn().mockResolvedValue(makeSummary()),
      getBindingsByChannelType: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    })

    const res = await app.inject({
      method: "DELETE",
      url: "/channels/cccccccc-1111-2222-3333-444444444444",
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.status).toBe("deleted")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.delete).toHaveBeenCalledWith("cccccccc-1111-2222-3333-444444444444")
  })

  it("returns 404 when channel does not exist", async () => {
    const { app } = await buildTestApp({
      getById: vi.fn().mockResolvedValue(undefined),
    })

    const res = await app.inject({
      method: "DELETE",
      url: "/channels/nonexistent-id",
    })

    expect(res.statusCode).toBe(404)
  })

  it("force=true cascades delete of bindings then channel", async () => {
    const bindings = [{ agent_id: "aaaa-1111", chat_id: "chat-1" }]
    const { app, service } = await buildTestApp({
      getById: vi.fn().mockResolvedValue(makeSummary()),
      getBindingsByChannelType: vi.fn().mockResolvedValue(bindings),
      removeBindingsByChannelType: vi.fn().mockResolvedValue(1),
      delete: vi.fn().mockResolvedValue(true),
    })

    const res = await app.inject({
      method: "DELETE",
      url: "/channels/cccccccc-1111-2222-3333-444444444444?force=true",
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.status).toBe("deleted")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.removeBindingsByChannelType).toHaveBeenCalledWith("telegram")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.delete).toHaveBeenCalledWith("cccccccc-1111-2222-3333-444444444444")
  })
})
