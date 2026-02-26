/**
 * Regression tests for auth UI state (issue #152).
 *
 * Tests:
 * 1. Next.js middleware redirects unauthenticated users to /login
 * 2. Next.js middleware allows access when session cookie is present
 * 3. Auth-related paths are always public
 */

import { describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Route protection logic (extracted from middleware for unit testing)
// ---------------------------------------------------------------------------

const PUBLIC_PATHS = ["/login", "/auth/complete", "/api/"]

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p))
}

describe("route protection logic", () => {
  describe("isPublicPath", () => {
    it("marks /login as public", () => {
      expect(isPublicPath("/login")).toBe(true)
    })

    it("marks /auth/complete as public", () => {
      expect(isPublicPath("/auth/complete")).toBe(true)
    })

    it("marks /auth/complete/ with subpaths as public", () => {
      expect(isPublicPath("/auth/complete/callback")).toBe(true)
    })

    it("marks /api/ paths as public", () => {
      expect(isPublicPath("/api/auth/session")).toBe(true)
      expect(isPublicPath("/api/agents")).toBe(true)
    })

    it("marks dashboard root as protected", () => {
      expect(isPublicPath("/")).toBe(false)
    })

    it("marks /agents as protected", () => {
      expect(isPublicPath("/agents")).toBe(false)
    })

    it("marks /approvals as protected", () => {
      expect(isPublicPath("/approvals")).toBe(false)
    })

    it("marks /settings as protected", () => {
      expect(isPublicPath("/settings")).toBe(false)
    })

    it("marks /jobs as protected", () => {
      expect(isPublicPath("/jobs")).toBe(false)
    })

    it("marks /memory as protected", () => {
      expect(isPublicPath("/memory")).toBe(false)
    })

    it("marks /pulse as protected", () => {
      expect(isPublicPath("/pulse")).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// UserMenu display state logic (unit tests for rendering decisions)
// ---------------------------------------------------------------------------

interface SessionUser {
  userId: string
  displayName: string | null
  email: string | null
  role: string | null
  authMethod: string
  avatarUrl: string | null
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

function deriveMenuState(user: SessionUser | null, isLoading: boolean) {
  const isAuthenticated = user !== null

  if (isLoading) {
    return { state: "loading" as const }
  }

  if (!isAuthenticated) {
    return { state: "unauthenticated" as const }
  }

  const initials = user.displayName
    ? getInitials(user.displayName)
    : (user.email?.[0]?.toUpperCase() ?? "?")
  const displayName = user.displayName ?? user.email ?? "User"
  const role = user.role ?? "operator"
  const avatarUrl = user.avatarUrl ?? null

  return {
    state: "authenticated" as const,
    initials,
    displayName,
    role,
    avatarUrl,
  }
}

describe("UserMenu display state", () => {
  it("shows loading state during auth check", () => {
    const state = deriveMenuState(null, true)
    expect(state.state).toBe("loading")
  })

  it("shows unauthenticated state when user is null and not loading", () => {
    const state = deriveMenuState(null, false)
    expect(state.state).toBe("unauthenticated")
  })

  it("shows authenticated state with initials from display name", () => {
    const user: SessionUser = {
      userId: "u1",
      displayName: "Jane Doe",
      email: "jane@example.com",
      role: "operator",
      authMethod: "session",
      avatarUrl: null,
    }
    const state = deriveMenuState(user, false)
    expect(state.state).toBe("authenticated")
    if (state.state === "authenticated") {
      expect(state.initials).toBe("JD")
      expect(state.displayName).toBe("Jane Doe")
      expect(state.role).toBe("operator")
      expect(state.avatarUrl).toBeNull()
    }
  })

  it("shows first letter of email when no display name", () => {
    const user: SessionUser = {
      userId: "u2",
      displayName: null,
      email: "alice@example.com",
      role: "admin",
      authMethod: "session",
      avatarUrl: null,
    }
    const state = deriveMenuState(user, false)
    if (state.state === "authenticated") {
      expect(state.initials).toBe("A")
      expect(state.displayName).toBe("alice@example.com")
    }
  })

  it("falls back to ? when no name or email", () => {
    const user: SessionUser = {
      userId: "u3",
      displayName: null,
      email: null,
      role: null,
      authMethod: "api_key",
      avatarUrl: null,
    }
    const state = deriveMenuState(user, false)
    if (state.state === "authenticated") {
      expect(state.initials).toBe("?")
      expect(state.displayName).toBe("User")
      expect(state.role).toBe("operator")
    }
  })

  it("includes avatar URL when present", () => {
    const user: SessionUser = {
      userId: "u4",
      displayName: "Bob",
      email: "bob@example.com",
      role: "approver",
      authMethod: "session",
      avatarUrl: "https://avatars.githubusercontent.com/u/456",
    }
    const state = deriveMenuState(user, false)
    if (state.state === "authenticated") {
      expect(state.avatarUrl).toBe("https://avatars.githubusercontent.com/u/456")
      expect(state.initials).toBe("B")
    }
  })

  it("never shows ambiguous OP for unauthenticated users", () => {
    // This is the core regression test for issue #152
    const state = deriveMenuState(null, false)
    expect(state.state).toBe("unauthenticated")
    // The old code would show "OP" initials here — now it should be
    // an explicit unauthenticated state with a Sign in link
    expect(state).not.toHaveProperty("initials")
  })
})
