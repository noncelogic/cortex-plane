"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionUser {
  userId: string
  displayName: string | null
  email: string | null
  role: string | null
  authMethod: string
}

interface AuthContextValue {
  /** Current user session, null if not authenticated */
  user: SessionUser | null
  /** True while checking initial session */
  isLoading: boolean
  /** True if user has an active session */
  isAuthenticated: boolean
  /** CSRF token for mutating requests */
  csrfToken: string | null
  /** Redirect to OAuth login for given provider */
  login: (provider: string) => void
  /** Destroy session and redirect to login */
  logout: () => Promise<void>
  /** Re-fetch session (e.g. after provider connection) */
  refreshSession: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  csrfToken: null,
  login: () => {},
  logout: async () => {},
  refreshSession: async () => {},
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
  const [isLoading, setIsLoading] = useState(true)
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
  const fetchSession = useCallback(async () => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      const storedCsrf = sessionStorage.getItem("cortex_csrf")
      if (storedCsrf) headers["x-csrf-token"] = storedCsrf

      const res = await fetch(`${API_BASE}/auth/session`, {
        credentials: "include",
        headers,
      })

      if (!res.ok) {
        if (mountedRef.current) {
          setUser(null)
          setIsLoading(false)
        }
        return
      }

      const data = (await res.json()) as SessionUser
      if (mountedRef.current) {
        setUser(data)
        setIsLoading(false)
      }
    } catch {
      if (mountedRef.current) {
        setUser(null)
        setIsLoading(false)
      }
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
      setCsrfToken(null)
      window.location.href = "/login"
    }
  }, [])

  const refreshSession = useCallback(async () => {
    await fetchSession()
  }, [fetchSession])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: user !== null,
      csrfToken,
      login,
      logout,
      refreshSession,
    }),
    [user, isLoading, csrfToken, login, logout, refreshSession],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
