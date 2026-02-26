import { describe, expect, it } from "vitest"

import { SessionService } from "../auth/session-service.js"

// ---------------------------------------------------------------------------
// Cookie serialization / parsing
// ---------------------------------------------------------------------------

describe("SessionService.serializeCookie", () => {
  it("produces a valid Set-Cookie header value", () => {
    const cookie = SessionService.serializeCookie("sess-123", 3600, false)
    expect(cookie).toContain("cortex_session=sess-123")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("Max-Age=3600")
    // Non-secure: should NOT contain Secure flag
    expect(cookie).not.toContain("Secure")
  })

  it("includes Secure flag when isSecure=true", () => {
    const cookie = SessionService.serializeCookie("s", 3600, true)
    expect(cookie).toContain("Secure")
  })
})

describe("SessionService.clearCookie", () => {
  it("sets Max-Age=0 to delete the cookie", () => {
    const cookie = SessionService.clearCookie(false)
    expect(cookie).toContain("cortex_session=")
    expect(cookie).toContain("Max-Age=0")
  })
})

describe("SessionService.parseSessionCookie", () => {
  it("extracts cortex_session from a cookie header", () => {
    const header = "cortex_session=abc-def-123; other=value"
    expect(SessionService.parseSessionCookie(header)).toBe("abc-def-123")
  })

  it("returns undefined for missing cookie", () => {
    expect(SessionService.parseSessionCookie("foo=bar")).toBeUndefined()
    expect(SessionService.parseSessionCookie(undefined)).toBeUndefined()
    expect(SessionService.parseSessionCookie("")).toBeUndefined()
  })

  it("handles cookie when cortex_session is the only one", () => {
    expect(SessionService.parseSessionCookie("cortex_session=xyz")).toBe("xyz")
  })

  it("handles multiple cookies", () => {
    const header = "foo=1; cortex_session=session-id-here; bar=2"
    expect(SessionService.parseSessionCookie(header)).toBe("session-id-here")
  })
})
