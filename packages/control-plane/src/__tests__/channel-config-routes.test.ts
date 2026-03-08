import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"

import type { ChannelConfigService } from "../channels/channel-config-service.js"
import type { AuthConfig } from "../middleware/types.js"
import { channelRoutes } from "../routes/channels.js"

// ---------------------------------------------------------------------------
// Mock: telegram-identity
// ---------------------------------------------------------------------------

const mockFetchIdentity = vi.hoisted(() => vi.fn())
vi.mock("../channels/telegram-identity.js", () => ({
  fetchTelegramBotIdentity: mockFetchIdentity,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const BOT_META = {
  bot_id: "987654321",
  username: "test_bot",
  display_name: "Test Bot",
}

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "cccccccc-1111-2222-3333-444444444444",
    type: "telegram",
    name: "My Telegram Bot",
    bot_metadata: null,
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

// ---------------------------------------------------------------------------
// Tests: POST /channels — bot identity on create
// ---------------------------------------------------------------------------

describe("POST /channels — bot identity", () => {
  it("passes bot metadata to service.create for telegram channels", async () => {
    mockFetchIdentity.mockResolvedValue(BOT_META)
    const { app, service } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/channels",
      payload: { type: "telegram", name: "New Bot", config: { botToken: "123:ABC" } },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.create).toHaveBeenCalledWith(
      "telegram",
      "New Bot",
      { botToken: "123:ABC" },
      null,
      BOT_META,
    )
  })

  it("passes null metadata when identity verification fails", async () => {
    mockFetchIdentity.mockResolvedValue(undefined)
    const { app, service } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: "/channels",
      payload: { type: "telegram", name: "New Bot", config: { botToken: "bad" } },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.create).toHaveBeenCalledWith(
      "telegram",
      "New Bot",
      { botToken: "bad" },
      null,
      null,
    )
  })

  it("skips identity check for non-telegram channels", async () => {
    mockFetchIdentity.mockClear()
    const { app } = await buildTestApp()

    await app.inject({
      method: "POST",
      url: "/channels",
      payload: { type: "discord", name: "My Discord", config: { token: "tok" } },
    })

    expect(mockFetchIdentity).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /channels/:id/verify — bot identity re-verification
// ---------------------------------------------------------------------------

describe("POST /channels/:id/verify", () => {
  it("returns updated channel with bot metadata on success", async () => {
    mockFetchIdentity.mockResolvedValue(BOT_META)

    const fullConfig = {
      ...makeSummary(),
      config: { botToken: "123:ABC" },
    }
    const { app, service } = await buildTestApp({
      getByIdFull: vi.fn().mockResolvedValue(fullConfig),
      update: vi.fn().mockResolvedValue(makeSummary({ bot_metadata: BOT_META })),
    })

    const res = await app.inject({
      method: "POST",
      url: "/channels/cccccccc-1111-2222-3333-444444444444/verify",
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.channel.bot_metadata).toEqual(BOT_META)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.update).toHaveBeenCalledWith("cccccccc-1111-2222-3333-444444444444", {
      bot_metadata: BOT_META,
    })
  })

  it("returns 404 when channel does not exist", async () => {
    const { app } = await buildTestApp({
      getByIdFull: vi.fn().mockResolvedValue(undefined),
    })

    const res = await app.inject({
      method: "POST",
      url: "/channels/nonexistent/verify",
    })

    expect(res.statusCode).toBe(404)
  })

  it("returns 400 for non-telegram channels", async () => {
    const fullConfig = {
      ...makeSummary({ type: "discord" }),
      config: { token: "tok" },
    }
    const { app } = await buildTestApp({
      getByIdFull: vi.fn().mockResolvedValue(fullConfig),
    })

    const res = await app.inject({
      method: "POST",
      url: "/channels/cccccccc-1111-2222-3333-444444444444/verify",
    })

    expect(res.statusCode).toBe(400)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.error).toBe("bad_request")
  })

  it("returns 502 when Telegram API is unreachable", async () => {
    mockFetchIdentity.mockResolvedValue(undefined)

    const fullConfig = {
      ...makeSummary(),
      config: { botToken: "123:ABC" },
    }
    const { app } = await buildTestApp({
      getByIdFull: vi.fn().mockResolvedValue(fullConfig),
    })

    const res = await app.inject({
      method: "POST",
      url: "/channels/cccccccc-1111-2222-3333-444444444444/verify",
    })

    expect(res.statusCode).toBe(502)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.error).toBe("upstream_error")
  })
})
