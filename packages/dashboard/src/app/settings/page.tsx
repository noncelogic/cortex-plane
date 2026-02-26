"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useState } from "react"

import { useAuth } from "@/components/auth-provider"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderInfo {
  id: string
  name: string
  authType: "oauth" | "api_key"
  description: string
}

interface Credential {
  id: string
  provider: string
  credentialType: string
  displayLabel: string | null
  maskedKey: string | null
  status: string
  lastUsedAt: string | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// Settings page inner (wrapped in Suspense)
// ---------------------------------------------------------------------------

function SettingsInner() {
  const { user, isAuthenticated, isLoading, csrfToken } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [loading, setLoading] = useState(true)

  // API key input state
  const [apiKeyForm, setApiKeyForm] = useState<{
    provider: string
    key: string
    label: string
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connected = searchParams.get("connected")
  const paramError = searchParams.get("error")

  // Redirect if not authenticated
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login")
    }
  }, [isLoading, isAuthenticated, router])

  // Fetch providers and credentials
  const fetchData = useCallback(async () => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (csrfToken) headers["x-csrf-token"] = csrfToken

      const [provRes, credRes] = await Promise.all([
        fetch("/api/credentials/providers", { credentials: "include", headers }),
        fetch("/api/credentials", { credentials: "include", headers }),
      ])

      if (provRes.ok) {
        const data = (await provRes.json()) as { providers?: ProviderInfo[] }
        setProviders(data.providers ?? [])
      }
      if (credRes.ok) {
        const data = (await credRes.json()) as { credentials?: Credential[] }
        setCredentials(data.credentials ?? [])
      }
    } catch {
      // Silently fail — display empty state
    } finally {
      setLoading(false)
    }
  }, [csrfToken])

  useEffect(() => {
    if (isAuthenticated) void fetchData()
  }, [isAuthenticated, fetchData])

  // Connect OAuth provider
  const connectOAuth = useCallback((provider: string) => {
    window.location.href = `/api/auth/connect/${provider}`
  }, [])

  // Save API key
  const saveApiKey = useCallback(async () => {
    if (!apiKeyForm) return
    setSaving(true)
    setError(null)

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (csrfToken) headers["x-csrf-token"] = csrfToken

      const res = await fetch("/api/credentials/api-key", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          provider: apiKeyForm.provider,
          apiKey: apiKeyForm.key,
          displayLabel: apiKeyForm.label || undefined,
        }),
      })

      if (!res.ok) {
        const data = (await res.json().catch(() => ({ message: "Failed to save" }))) as {
          message?: string
        }
        setError(data.message ?? "Failed to save API key")
        return
      }

      setApiKeyForm(null)
      void fetchData()
    } catch {
      setError("Failed to save API key")
    } finally {
      setSaving(false)
    }
  }, [apiKeyForm, csrfToken, fetchData])

  // Delete credential
  const deleteCredential = useCallback(
    async (id: string) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      if (csrfToken) headers["x-csrf-token"] = csrfToken

      await fetch(`/api/credentials/${id}`, {
        method: "DELETE",
        credentials: "include",
        headers,
      })
      void fetchData()
    },
    [csrfToken, fetchData],
  )

  if (isLoading || loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  const getCredentialForProvider = (providerId: string) =>
    credentials.find((c) => c.provider === providerId)

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl font-bold text-text-main">Settings</h1>
        <p className="mt-1 text-sm text-text-muted">
          Manage your account and connected LLM providers.
        </p>
      </div>

      {/* Account info */}
      <section className="rounded-xl border border-surface-border bg-surface-light p-6">
        <h2 className="text-lg font-semibold text-text-main">Account</h2>
        <div className="mt-3 space-y-1 text-sm">
          <p>
            <span className="text-text-muted">Name:</span>{" "}
            <span className="text-text-main">{user?.displayName ?? "—"}</span>
          </p>
          <p>
            <span className="text-text-muted">Email:</span>{" "}
            <span className="text-text-main">{user?.email ?? "—"}</span>
          </p>
          <p>
            <span className="text-text-muted">Role:</span>{" "}
            <span className="inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-primary">
              {user?.role ?? "operator"}
            </span>
          </p>
        </div>
      </section>

      {/* Status messages */}
      {connected && (
        <div className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          Successfully connected {connected}. Your credentials are encrypted and stored securely.
        </div>
      )}
      {paramError && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          Connection error: {paramError}
        </div>
      )}

      {/* Connected Providers */}
      <section className="rounded-xl border border-surface-border bg-surface-light p-6">
        <h2 className="text-lg font-semibold text-text-main">Connected Providers</h2>
        <p className="mt-1 text-sm text-text-muted">
          Connect your LLM provider accounts. Credentials are encrypted with AES-256-GCM.
        </p>

        <div className="mt-4 space-y-3">
          {providers.map((p) => {
            const cred = getCredentialForProvider(p.id)
            const isOAuth = p.authType === "oauth"

            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-surface-border p-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-main">{p.name}</span>
                    {cred && (
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                          cred.status === "active"
                            ? "bg-success/10 text-success"
                            : cred.status === "expired"
                              ? "bg-warning/10 text-warning"
                              : "bg-danger/10 text-danger"
                        }`}
                      >
                        {cred.status}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted">{p.description}</p>
                  {cred?.maskedKey && (
                    <p className="mt-1 font-mono text-xs text-text-muted">{cred.maskedKey}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {cred ? (
                    <button
                      type="button"
                      onClick={() => void deleteCredential(cred.id)}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
                    >
                      Disconnect
                    </button>
                  ) : isOAuth ? (
                    <button
                      type="button"
                      onClick={() => connectOAuth(p.id)}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-content hover:bg-primary/90 transition-colors"
                    >
                      Connect
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setApiKeyForm({ provider: p.id, key: "", label: "" })}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-content hover:bg-primary/90 transition-colors"
                    >
                      Add Key
                    </button>
                  )}
                </div>
              </div>
            )
          })}

          {providers.length === 0 && (
            <p className="py-4 text-center text-sm text-text-muted">
              No providers configured. Configure provider credentials in the control plane.
            </p>
          )}
        </div>
      </section>

      {/* API Key entry modal */}
      {apiKeyForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-text-main">
              Add API Key — {providers.find((p) => p.id === apiKeyForm.provider)?.name}
            </h3>

            {error && (
              <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">API Key</label>
                <input
                  type="password"
                  value={apiKeyForm.key}
                  onChange={(e) => setApiKeyForm((f) => (f ? { ...f, key: e.target.value } : f))}
                  className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="sk-..."
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Label (optional)
                </label>
                <input
                  type="text"
                  value={apiKeyForm.label}
                  onChange={(e) => setApiKeyForm((f) => (f ? { ...f, label: e.target.value } : f))}
                  className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="e.g., Production key"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setApiKeyForm(null)
                  setError(null)
                }}
                className="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveApiKey()}
                disabled={saving || apiKeyForm.key.length < 8}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-content hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page export
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12">
          <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <SettingsInner />
    </Suspense>
  )
}
