"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"

import { useAuth } from "@/components/auth-provider"

// ---------------------------------------------------------------------------
// Error display mapping
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
  auth_failed: "Authentication failed. Please try again.",
  invalid_state: "Invalid OAuth state. Please try again.",
  missing_params: "Missing authentication parameters.",
  provider_not_configured: "This login provider is not configured.",
  session_expired: "Your session has expired. Please sign in again.",
}

// ---------------------------------------------------------------------------
// Login page inner (needs Suspense for useSearchParams)
// ---------------------------------------------------------------------------

function LoginInner() {
  const { login, isAuthenticated, isLoading } = useAuth()
  const searchParams = useSearchParams()
  const router = useRouter()
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  const [loadingProviders, setLoadingProviders] = useState(true)

  const error = searchParams.get("error")

  // Redirect if already authenticated
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/")
    }
  }, [isLoading, isAuthenticated, router])

  // Fetch available providers
  useEffect(() => {
    fetch("/api/auth/providers")
      .then((res) => (res.ok ? res.json() : { providers: [] }))
      .then((data: { providers: { id: string; name: string }[] }) => {
        setProviders(data.providers)
        setLoadingProviders(false)
      })
      .catch(() => setLoadingProviders(false))
  }, [])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-dark">
        <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-dark p-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary">
            <span className="text-lg font-bold text-primary-content">CP</span>
          </div>
          <h1 className="mt-4 font-display text-2xl font-bold text-text-main">Cortex Plane</h1>
          <p className="mt-1 text-sm text-text-muted">
            Sign in to the agent orchestration dashboard
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {ERROR_MESSAGES[error] ?? `Authentication error: ${error}`}
          </div>
        )}

        {/* OAuth buttons */}
        <div className="space-y-3">
          {loadingProviders ? (
            <div className="flex justify-center py-4">
              <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : providers.length === 0 ? (
            <div className="rounded-lg border border-surface-border bg-surface-light px-4 py-6 text-center">
              <p className="text-sm text-text-muted">
                No login providers configured. Set{" "}
                <code className="text-xs">OAUTH_GOOGLE_CLIENT_ID</code> or{" "}
                <code className="text-xs">OAUTH_GITHUB_CLIENT_ID</code> to enable OAuth login.
              </p>
            </div>
          ) : (
            providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => login(p.id)}
                className="flex w-full items-center justify-center gap-3 rounded-lg border border-surface-border bg-surface-light px-4 py-3 text-sm font-medium text-text-main transition-colors hover:bg-secondary"
              >
                <ProviderIcon provider={p.id} />
                <span>Continue with {p.name}</span>
              </button>
            ))
          )}
        </div>

        {/* API key fallback hint */}
        <p className="mt-6 text-center text-xs text-text-muted">
          For API access, use an <code className="text-[10px]">X-API-Key</code> header.
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Provider icons (inline SVG)
// ---------------------------------------------------------------------------

function ProviderIcon({ provider }: { provider: string }) {
  switch (provider) {
    case "google":
      return (
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
      )
    case "github":
      return (
        <svg viewBox="0 0 24 24" className="size-5 fill-current" aria-hidden="true">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
        </svg>
      )
    default:
      return <span className="material-symbols-outlined text-[20px] text-text-muted">key</span>
  }
}

// ---------------------------------------------------------------------------
// Page export (wrapped in Suspense for useSearchParams)
// ---------------------------------------------------------------------------

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface-dark">
          <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <LoginInner />
    </Suspense>
  )
}
