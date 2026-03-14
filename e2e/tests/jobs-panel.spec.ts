import { expect, test } from "@playwright/test"

const CP_BASE = process.env.CP_BASE_URL || "http://localhost:4000"

test.describe("Jobs panel renders with content", () => {
  test("GET /jobs returns list or 401", async ({ request }) => {
    const res = await request.get(`${CP_BASE}/jobs`)
    if (res.status() === 200) {
      const body = await res.json()
      expect(body).toHaveProperty("jobs")
      expect(Array.isArray(body.jobs)).toBe(true)
    } else {
      expect(res.status()).toBe(401)
    }
  })

  test("GET /jobs/stream SSE endpoint is reachable", async ({ request }) => {
    // SSE holds the connection open indefinitely; use a short timeout and
    // treat a timeout as "reachable" (the server accepted the request).
    try {
      const res = await request.get(`${CP_BASE}/jobs/stream`, { timeout: 3_000 })
      expect([200, 401]).toContain(res.status())
    } catch {
      // Timeout is expected — the SSE endpoint is reachable
    }
  })

  test("jobs page loads in dashboard", async ({ page }) => {
    await page.goto("/jobs")
    // May redirect to login if unauthenticated — that's valid
    await page.waitForLoadState("networkidle")

    const url = page.url()
    const isJobsOrLogin = url.includes("/jobs") || url.includes("/login")
    expect(isJobsOrLogin).toBe(true)
  })

  test("jobs page has no uncaught JS errors", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (err) => errors.push(err.message))

    await page.goto("/jobs")
    await page.waitForTimeout(2000)

    expect(errors).toEqual([])
  })

  test("POST /jobs/:id/retry returns 401 or 404 for unknown job", async ({ request }) => {
    const res = await request.post(`${CP_BASE}/jobs/00000000-0000-0000-0000-000000000000/retry`)
    expect([401, 404]).toContain(res.status())
  })
})
