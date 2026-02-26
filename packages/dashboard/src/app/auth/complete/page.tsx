"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useRef } from "react"

import { useAuth } from "@/components/auth-provider"

/**
 * /auth/complete — OAuth callback landing page.
 *
 * The backend redirects here after a successful OAuth login with ?csrf=<token>.
 * We store the CSRF token in sessionStorage, refresh the auth session, and
 * redirect to the dashboard once the session is confirmed.
 */
function AuthCompleteInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { refreshSession, isAuthenticated, isLoading } = useAuth()
  const hydratedRef = useRef(false)

  // Store CSRF token and trigger session refresh
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true

    const csrf = searchParams.get("csrf")
    if (csrf) {
      sessionStorage.setItem("cortex_csrf", csrf)
    }
    // Re-fetch session now that cookie + CSRF are available
    void refreshSession()
  }, [searchParams, refreshSession])

  // Redirect once session is confirmed
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/")
    }
  }, [isLoading, isAuthenticated, router])

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-dark">
      <div className="text-center">
        <div className="mx-auto size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="mt-4 text-sm text-text-muted">Completing sign in...</p>
      </div>
    </div>
  )
}

export default function AuthCompletePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface-dark">
          <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <AuthCompleteInner />
    </Suspense>
  )
}
