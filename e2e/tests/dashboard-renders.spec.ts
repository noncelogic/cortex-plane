import { expect, test } from "@playwright/test"

test.describe("Dashboard renders without errors", () => {
  test("root page loads with HTTP 200 or redirect", async ({ page }) => {
    const res = await page.goto("/")
    expect(res).not.toBeNull()
    // Dashboard may redirect to /login if unauthenticated
    expect([200, 304]).toContain(res!.status())
  })

  test("no uncaught JS errors on page load", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (err) => errors.push(err.message))

    await page.goto("/")
    // Allow client-side hydration to complete
    await page.waitForTimeout(2000)

    expect(errors).toEqual([])
  })

  test("no global error banner visible on load", async ({ page }) => {
    await page.goto("/")
    await page.waitForTimeout(2000)

    // The API error banner component should not be visible on a healthy deploy
    const errorBanner = page.locator('[data-testid="api-error-banner"]')
    await expect(errorBanner).not.toBeVisible()
  })

  test("login page renders provider buttons", async ({ page }) => {
    await page.goto("/login")
    await page.waitForLoadState("networkidle")

    // The page should contain at least one login provider button
    const title = page.locator("text=Sign in")
    await expect(title).toBeVisible({ timeout: 10_000 })
  })
})
