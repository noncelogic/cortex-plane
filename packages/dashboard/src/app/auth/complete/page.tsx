"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect } from "react"

/**
 * /auth/complete — OAuth callback landing page.
 *
 * The backend redirects here after a successful OAuth login with ?csrf=<token>.
 * We store the CSRF token in sessionStorage and redirect to the dashboard.
 */
function AuthCompleteInner() {
  const searchParams = useSearchParams()
  const router = useRouter()

  useEffect(() => {
    const csrf = searchParams.get("csrf")
    if (csrf) {
      sessionStorage.setItem("cortex_csrf", csrf)
    }
    // Redirect to dashboard — the AuthProvider will pick up the session cookie
    router.replace("/")
  }, [searchParams, router])

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
