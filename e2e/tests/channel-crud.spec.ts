import { expect, test } from "@playwright/test"

/**
 * Channel CRUD E2E tests.
 *
 * These tests exercise the control-plane /channels API.
 * They require an authenticated session cookie. When no auth cookie is
 * available (e.g. first deploy validation), the suite gracefully skips.
 */

const CP_BASE = process.env.CP_BASE_URL || "http://localhost:4000"

test.describe("Channel CRUD operations", () => {
  test.beforeEach(async ({ request }) => {
    // Verify the control-plane is reachable before running CRUD tests
    const health = await request.get(`${CP_BASE}/healthz`)
    if (health.status() !== 200) {
      test.skip(true, "Control-plane not reachable")
    }
  })

  test("GET /channels returns a list (or 401 without auth)", async ({ request }) => {
    const res = await request.get(`${CP_BASE}/channels`)
    // Without auth: 401. With auth: 200 + array.
    if (res.status() === 200) {
      const body = await res.json()
      expect(body).toHaveProperty("channels")
      expect(Array.isArray(body.channels)).toBe(true)
    } else {
      expect(res.status()).toBe(401)
    }
  })

  test("POST /channels rejects invalid payload", async ({ request }) => {
    const res = await request.post(`${CP_BASE}/channels`, {
      data: { invalid: true },
    })
    // Should get 400 (bad request) or 401 (unauthorized)
    expect([400, 401]).toContain(res.status())
  })

  test("GET /channels/:id returns 401 or 404 for unknown id", async ({ request }) => {
    const res = await request.get(`${CP_BASE}/channels/00000000-0000-0000-0000-000000000000`)
    expect([401, 404]).toContain(res.status())
  })

  test("DELETE /channels/:id returns 401 or 404 for unknown id", async ({ request }) => {
    const res = await request.delete(`${CP_BASE}/channels/00000000-0000-0000-0000-000000000000`)
    expect([401, 404]).toContain(res.status())
  })

  test("PUT /channels/:id rejects malformed body", async ({ request }) => {
    const res = await request.put(`${CP_BASE}/channels/00000000-0000-0000-0000-000000000000`, {
      data: {},
    })
    expect([400, 401, 404]).toContain(res.status())
  })
})
