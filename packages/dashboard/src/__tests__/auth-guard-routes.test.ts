import { describe, expect, it } from "vitest"

import { resolveAuthGuard } from "@/lib/auth-guard"

describe("protected route coverage", () => {
  const protectedRoutes = [
    "/",
    "/agents",
    "/agents/agt-123",
    "/jobs",
    "/approvals",
    "/memory",
    "/pulse",
    "/settings",
  ]

  it("requires login for every protected route", () => {
    for (const route of protectedRoutes) {
      const result = resolveAuthGuard(route, "unauthenticated")
      expect(result.shouldRedirectToLogin).toBe(true)
      expect(result.shouldHideChrome).toBe(false)
    }
  })

  it("keeps every protected route blocked during unverified session state", () => {
    for (const route of protectedRoutes) {
      const result = resolveAuthGuard(route, "unverified")
      expect(result.shouldShowUnverified).toBe(true)
      expect(result.shouldRedirectToLogin).toBe(false)
    }
  })
})
