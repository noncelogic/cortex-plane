import { defineConfig } from "@playwright/test"

/**
 * Cortex Plane — E2E test configuration.
 *
 * Environment variables:
 *   CP_BASE_URL      Control-plane URL   (default: http://localhost:4000)
 *   DASH_BASE_URL    Dashboard URL        (default: http://localhost:3000)
 *   E2E_TIMEOUT      Per-test timeout ms  (default: 30 000)
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "html",
  timeout: Number(process.env.E2E_TIMEOUT) || 30_000,

  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "api-smoke",
      testMatch: "health-smoke.spec.ts",
      use: {
        baseURL: process.env.CP_BASE_URL || "http://localhost:4000",
      },
    },
    {
      name: "dashboard",
      testMatch: "dashboard-renders.spec.ts",
      use: {
        baseURL: process.env.DASH_BASE_URL || "http://localhost:3000",
      },
    },
    {
      name: "oauth-redirect",
      testMatch: "oauth-redirect.spec.ts",
      use: {
        baseURL: process.env.DASH_BASE_URL || "http://localhost:3000",
      },
    },
    {
      name: "channel-crud",
      testMatch: "channel-crud.spec.ts",
      use: {
        baseURL: process.env.CP_BASE_URL || "http://localhost:4000",
      },
    },
    {
      name: "jobs-panel",
      testMatch: "jobs-panel.spec.ts",
      use: {
        baseURL: process.env.DASH_BASE_URL || "http://localhost:3000",
      },
    },
  ],
})
