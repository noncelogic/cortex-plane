import { describe, expect, it } from "vitest"

import { isPublicAuthPath, resolveAuthGuard } from "@/lib/auth-guard"
import { getUserInitials } from "@/lib/auth-ui"

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
    expect(isPublicAuthPath("/auth/complete/step")).toBe(false)
    expect(isPublicAuthPath("/login/")).toBe(true)
    expect(isPublicAuthPath("/")).toBe(false)
  })

  it("keeps protected routes loading while session state is hydrating", () => {
    expect(resolveAuthGuard("/", "loading")).toEqual({
      shouldHideChrome: false,
      shouldShowLoading: true,
      shouldShowUnverified: false,
      shouldRedirectToLogin: false,
      shouldRedirectToDashboard: false,
    })
  })

  it("redirects protected routes to login when unauthenticated", () => {
    expect(resolveAuthGuard("/agents", "unauthenticated")).toEqual({
      shouldHideChrome: false,
      shouldShowLoading: false,
      shouldShowUnverified: false,
      shouldRedirectToLogin: true,
      shouldRedirectToDashboard: false,
    })
  })

  it("allows protected routes when authenticated", () => {
    expect(resolveAuthGuard("/jobs", "authenticated")).toEqual({
      shouldHideChrome: false,
      shouldShowLoading: false,
      shouldShowUnverified: false,
      shouldRedirectToLogin: false,
      shouldRedirectToDashboard: false,
    })
  })

  it("blocks protected routes in unverified state without redirecting", () => {
    expect(resolveAuthGuard("/memory", "unverified")).toEqual({
      shouldHideChrome: false,
      shouldShowLoading: false,
      shouldShowUnverified: true,
      shouldRedirectToLogin: false,
      shouldRedirectToDashboard: false,
    })
  })

  it("redirects public auth routes to dashboard only when authenticated", () => {
    expect(resolveAuthGuard("/login", "authenticated")).toEqual({
      shouldHideChrome: true,
      shouldShowLoading: false,
      shouldShowUnverified: false,
      shouldRedirectToLogin: false,
      shouldRedirectToDashboard: true,
    })

    expect(resolveAuthGuard("/login", "unverified")).toEqual({
      shouldHideChrome: true,
      shouldShowLoading: false,
      shouldShowUnverified: false,
      shouldRedirectToLogin: false,
      shouldRedirectToDashboard: false,
    })
  })
})
