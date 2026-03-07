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
