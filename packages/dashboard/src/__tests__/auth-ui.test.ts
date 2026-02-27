import { describe, expect, it } from "vitest"

import { getUserInitials, isPublicAuthPath, resolveAuthGuard } from "@/lib/auth-ui"

describe("auth-ui helpers", () => {
  it("uses display name initials for authenticated users", () => {
    expect(
      getUserInitials({
        userId: "u1",
        displayName: "Octo Cat",
        email: "octo@example.com",
        role: "operator",
        authMethod: "session",
      }),
    ).toBe("OC")
  })

  it("falls back to email initials when display name is missing", () => {
    expect(
      getUserInitials({
        userId: "u1",
        displayName: null,
        email: "alice@example.com",
        role: "operator",
        authMethod: "session",
      }),
    ).toBe("AL")
  })

  it("uses unknown initials when no user identity exists", () => {
    expect(getUserInitials(null)).toBe("?")
  })

  it("treats login and auth completion as public auth paths", () => {
    expect(isPublicAuthPath("/login")).toBe(true)
    expect(isPublicAuthPath("/auth/complete")).toBe(true)
    expect(isPublicAuthPath("/auth/complete/step")).toBe(true)
    expect(isPublicAuthPath("/")).toBe(false)
  })

  it("keeps protected routes loading while session state is hydrating", () => {
    expect(resolveAuthGuard("/", true, false)).toEqual({
      shouldHideChrome: false,
      shouldShowLoading: true,
      shouldRedirectToLogin: false,
    })
  })

  it("redirects protected routes to login when unauthenticated", () => {
    expect(resolveAuthGuard("/agents", false, false)).toEqual({
      shouldHideChrome: false,
      shouldShowLoading: false,
      shouldRedirectToLogin: true,
    })
  })

  it("allows protected routes when authenticated", () => {
    expect(resolveAuthGuard("/jobs", false, true)).toEqual({
      shouldHideChrome: false,
      shouldShowLoading: false,
      shouldRedirectToLogin: false,
    })
  })
})
