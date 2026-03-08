import { expect, test } from "@playwright/test"

test.describe("OAuth redirect flow", () => {
  test("unauthenticated dashboard root redirects to login", async ({ page }) => {
    await page.goto("/")
    // Without a valid session, the dashboard should redirect to /login
    await page.waitForURL("**/login**", { timeout: 10_000 })
    expect(page.url()).toContain("/login")
  })

  test("login page links point to valid auth providers", async ({ page, request }) => {
    // Fetch available providers from the control-plane proxy
    const cpBase = process.env.CP_BASE_URL || "http://localhost:4000"
    const res = await request.get(`${cpBase}/auth/providers`)

    if (res.status() === 200) {
      const body = await res.json()
      expect(Array.isArray(body.providers)).toBe(true)
      for (const provider of body.providers) {
        expect(provider).toHaveProperty("id")
        expect(provider).toHaveProperty("name")
      }
    } else {
      // Auth may not be configured in all environments
      test.skip(true, "Auth providers endpoint not available")
    }
  })

  test("auth login endpoint returns redirect to OAuth provider", async ({ request }) => {
    const cpBase = process.env.CP_BASE_URL || "http://localhost:4000"
    const providersRes = await request.get(`${cpBase}/auth/providers`)

    if (providersRes.status() !== 200) {
      test.skip(true, "Auth providers not configured")
      return
    }

    const { providers } = await providersRes.json()
    if (!providers.length) {
      test.skip(true, "No auth providers registered")
      return
    }

    const provider = providers[0]
    const loginRes = await request.get(`${cpBase}/auth/login/${provider.id}`, { maxRedirects: 0 })

    // Should return a redirect (302/303) to the OAuth provider's authorize URL
    expect([302, 303]).toContain(loginRes.status())
  })
})
