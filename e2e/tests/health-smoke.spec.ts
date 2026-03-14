import { expect, test } from "@playwright/test"

test.describe("Control-plane health endpoints", () => {
  test("GET /healthz returns 200", async ({ request }) => {
    const res = await request.get("/healthz")
    expect(res.status()).toBe(200)

    const body = await res.json()
    expect(body.status).toMatch(/^(ok|degraded)$/)
  })

  test("GET /readyz returns 200 (DB + worker ready)", async ({ request }) => {
    const res = await request.get("/readyz")
    expect(res.status()).toBe(200)

    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.checks.db).toBe(true)
    expect(body.checks.worker).toBe(true)
  })

  test("GET /health/backends returns backend status", async ({ request }) => {
    const res = await request.get("/health/backends")
    // 200 or 503 depending on configured backends; shape matters
    expect([200, 503]).toContain(res.status())

    const body = await res.json()
    // When backends are configured the response has a `backends` array;
    // otherwise the API returns `{ status, reason }`.
    if (Array.isArray(body.backends)) {
      expect(body.backends.length).toBeGreaterThanOrEqual(0)
    } else {
      expect(body).toHaveProperty("status")
    }
  })

  test("GET /health/mcp returns MCP status", async ({ request }) => {
    const res = await request.get("/health/mcp")
    expect([200, 503]).toContain(res.status())

    const body = await res.json()
    expect(body).toHaveProperty("status")
  })

  test("unknown route returns 404", async ({ request }) => {
    const res = await request.get("/this-route-does-not-exist")
    expect(res.status()).toBe(404)
  })
})
