import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"

import type { ChannelAllowlistService } from "../channels/channel-allowlist-service.js"
import type { AuthConfig } from "../middleware/types.js"
import { channelAllowlistRoutes } from "../routes/channel-allowlist.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_AUTH_CONFIG: AuthConfig = {
  requireAuth: false,
  apiKeys: [],
}

const CHANNEL_ID = "cccccccc-1111-2222-3333-444444444444"
const ENTRY_ID = "eeeeeeee-1111-2222-3333-444444444444"
const now = new Date()

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    channel_config_id: CHANNEL_ID,
    platform_user_id: "tg-12345",
    display_name: "Alice",
    note: null,
    added_by: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

function mockService(overrides: Partial<ChannelAllowlistService> = {}): ChannelAllowlistService {
  return {
    listEntries: vi.fn().mockResolvedValue([makeEntry()]),
    addEntry: vi.fn().mockResolvedValue(makeEntry()),
    removeEntry: vi.fn().mockResolvedValue(makeEntry()),
    isAllowed: vi.fn().mockResolvedValue(true),
    getPolicy: vi.fn().mockResolvedValue("open"),
    setPolicy: vi.fn().mockResolvedValue(true),
    getAuditLog: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ChannelAllowlistService
}

async function buildTestApp(serviceOverrides: Partial<ChannelAllowlistService> = {}) {
  const app = Fastify({ logger: false })
  const service = mockService(serviceOverrides)

  await app.register(channelAllowlistRoutes({ service, authConfig: DEV_AUTH_CONFIG }))

  return { app, service }
}

// ---------------------------------------------------------------------------
// Tests: GET /channels/:id/allowlist
// ---------------------------------------------------------------------------

describe("GET /channels/:id/allowlist", () => {
  it("returns allowlist entries for a channel", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/channels/${CHANNEL_ID}/allowlist`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.entries).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.entries[0].platform_user_id).toBe("tg-12345")
  })
})

// ---------------------------------------------------------------------------
// Tests: POST /channels/:id/allowlist
// ---------------------------------------------------------------------------

describe("POST /channels/:id/allowlist", () => {
  it("adds an entry and returns 201", async () => {
    const { app, service } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/channels/${CHANNEL_ID}/allowlist`,
      payload: {
        platform_user_id: "tg-12345",
        display_name: "Alice",
      },
    })

    expect(res.statusCode).toBe(201)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.entry.platform_user_id).toBe("tg-12345")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.addEntry).toHaveBeenCalled()
  })

  it("returns 400 when platform_user_id is missing", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "POST",
      url: `/channels/${CHANNEL_ID}/allowlist`,
      payload: {},
    })

    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Tests: DELETE /channels/:id/allowlist/:entryId
// ---------------------------------------------------------------------------

describe("DELETE /channels/:id/allowlist/:entryId", () => {
  it("removes entry and returns 200", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "DELETE",
      url: `/channels/${CHANNEL_ID}/allowlist/${ENTRY_ID}`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.status).toBe("removed")
  })

  it("returns 404 when entry not found", async () => {
    const { app } = await buildTestApp({
      removeEntry: vi.fn().mockResolvedValue(undefined),
    })

    const res = await app.inject({
      method: "DELETE",
      url: `/channels/${CHANNEL_ID}/allowlist/nonexistent`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /channels/:id/policy
// ---------------------------------------------------------------------------

describe("GET /channels/:id/policy", () => {
  it("returns the inbound policy", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "GET",
      url: `/channels/${CHANNEL_ID}/policy`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.policy).toBe("open")
  })

  it("returns 404 when channel not found", async () => {
    const { app } = await buildTestApp({
      getPolicy: vi.fn().mockResolvedValue(undefined),
    })

    const res = await app.inject({
      method: "GET",
      url: `/channels/nonexistent/policy`,
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: PUT /channels/:id/policy
// ---------------------------------------------------------------------------

describe("PUT /channels/:id/policy", () => {
  it("sets the inbound policy", async () => {
    const { app, service } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/channels/${CHANNEL_ID}/policy`,
      payload: { policy: "allowlist" },
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.policy).toBe("allowlist")
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(service.setPolicy).toHaveBeenCalledWith(CHANNEL_ID, "allowlist", null)
  })

  it("returns 400 for invalid policy", async () => {
    const { app } = await buildTestApp()

    const res = await app.inject({
      method: "PUT",
      url: `/channels/${CHANNEL_ID}/policy`,
      payload: { policy: "invalid" },
    })

    expect(res.statusCode).toBe(400)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.error).toBe("bad_request")
  })

  it("returns 404 when channel not found", async () => {
    const { app } = await buildTestApp({
      setPolicy: vi.fn().mockResolvedValue(false),
    })

    const res = await app.inject({
      method: "PUT",
      url: `/channels/${CHANNEL_ID}/policy`,
      payload: { policy: "open" },
    })

    expect(res.statusCode).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Tests: GET /channels/:id/allowlist/audit
// ---------------------------------------------------------------------------

describe("GET /channels/:id/allowlist/audit", () => {
  it("returns audit log entries", async () => {
    const auditEntries = [
      {
        id: "aaaa",
        channel_config_id: CHANNEL_ID,
        action: "entry_added",
        platform_user_id: "tg-12345",
        performed_by: null,
        detail: {},
        created_at: now,
      },
    ]
    const { app } = await buildTestApp({
      getAuditLog: vi.fn().mockResolvedValue(auditEntries),
    })

    const res = await app.inject({
      method: "GET",
      url: `/channels/${CHANNEL_ID}/allowlist/audit`,
    })

    expect(res.statusCode).toBe(200)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const body = res.json()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.entries).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(body.entries[0].action).toBe("entry_added")
  })
})
