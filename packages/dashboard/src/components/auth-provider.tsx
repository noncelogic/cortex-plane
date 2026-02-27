"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionUser {
  userId: string
  displayName: string | null
  email: string | null
  avatarUrl?: string | null
  role: string | null
  authMethod: string
}

export type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "unverified"

interface AuthContextValue {
  /** Current user session, null if not authenticated */
  user: SessionUser | null
  /** Canonical auth state for route guards and navigation UI */
  authStatus: AuthStatus
  /** True while checking initial session */
  isLoading: boolean
  /** True if user has an active session */
  isAuthenticated: boolean
  /** Last session verification error (if any) */
  authError: string | null
  /** CSRF token for mutating requests */
  csrfToken: string | null
  /** Redirect to OAuth login for given provider */
  login: (provider: string) => void
  /** Destroy session and redirect to login */
  logout: () => Promise<void>
  /** Re-fetch session (e.g. after provider connection) */
  refreshSession: () => Promise<AuthStatus>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  authStatus: "loading",
  isLoading: true,
  isAuthenticated: false,
  authError: null,
  csrfToken: null,
  login: () => {},
  logout: async () => {},
  refreshSession: async () => "unauthenticated",
})

export function useAuth() {
  return useContext(AuthContext)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const API_BASE = "/api"

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading")
  const [authError, setAuthError] = useState<string | null>(null)
  const [csrfToken, setCsrfToken] = useState<string | null>(null)
  const mountedRef = useRef(true)

  // Check for CSRF token stored by auth/complete page
  useEffect(() => {
    const stored = sessionStorage.getItem("cortex_csrf")
    if (stored) {
      setCsrfToken(stored)
    }
  }, [])

  // Fetch current session on mount
  const fetchSession = useCallback(async (): Promise<AuthStatus> => {
    if (mountedRef.current) {
      setAuthStatus("loading")
      setAuthError(null)
    }

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      const storedCsrf = sessionStorage.getItem("cortex_csrf")
      if (storedCsrf) headers["x-csrf-token"] = storedCsrf

      const res = await fetch(`${API_BASE}/auth/session`, {
        cache: "no-store",
        credentials: "include",
        headers,
      })

      if (!res.ok) {
        const nextStatus: AuthStatus = res.status === 401 || res.status === 403 ? "unauthenticated" : "unverified"
        if (mountedRef.current) {
          setUser(null)
          setAuthStatus(nextStatus)
          setAuthError(`session_http_${res.status}`)
        }
        return nextStatus
      }

      const data = (await res.json()) as SessionUser
      if (mountedRef.current) {
        setUser(data)
        setAuthStatus("authenticated")
        setAuthError(null)
      }
      return "authenticated"
    } catch {
      if (mountedRef.current) {
        setUser(null)
        setAuthStatus("unverified")
        setAuthError("session_network_error")
      }
      return "unverified"
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void fetchSession()
    return () => {
      mountedRef.current = false
    }
  }, [fetchSession])

  const login = useCallback((provider: string) => {
    window.location.href = `${API_BASE}/auth/login/${provider}`
  }, [])

  const logout = useCallback(async () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const storedCsrf = sessionStorage.getItem("cortex_csrf")
    if (storedCsrf) headers["x-csrf-token"] = storedCsrf

    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers,
      })
    } finally {
      sessionStorage.removeItem("cortex_csrf")
      setUser(null)
      setAuthStatus("unauthenticated")
      setAuthError(null)
      setCsrfToken(null)
      window.location.href = "/login"
    }
  }, [])

  const refreshSession = useCallback(async () => {
    return fetchSession()
  }, [fetchSession])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      authStatus,
      isLoading: authStatus === "loading",
      isAuthenticated: authStatus === "authenticated",
      authError,
      csrfToken,
      login,
      logout,
      refreshSession,
    }),
    [user, authStatus, authError, csrfToken, login, logout, refreshSession],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
