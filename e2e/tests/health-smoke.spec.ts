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
    expect(body.checks.db).toBe("ok")
    expect(body.checks.worker).toBe("ok")
  })

  test("GET /health/backends returns backend status", async ({ request }) => {
    const res = await request.get("/health/backends")
    // 200 or 503 depending on configured backends; shape matters
    expect([200, 503]).toContain(res.status())

    const body = await res.json()
    expect(body).toHaveProperty("backends")
    expect(Array.isArray(body.backends)).toBe(true)
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
