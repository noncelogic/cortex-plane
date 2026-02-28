"use client"

import { useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useState } from "react"

import { useAuth } from "@/components/auth-provider"
import {
  type Credential,
  deleteCredential as apiDeleteCredential,
  exchangeOAuthConnect,
  initOAuthConnect,
  listCredentials,
  listProviders,
  type ProviderInfo,
  saveProviderApiKey,
} from "@/lib/api-client"

/** Code-paste providers that use the init/exchange flow. */
const CODE_PASTE_PROVIDER_IDS = new Set(["google-antigravity", "openai-codex", "anthropic"])

// ---------------------------------------------------------------------------
// Settings page inner (wrapped in Suspense)
// ---------------------------------------------------------------------------

function SettingsInner() {
  const { user, authStatus } = useAuth()
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

  // Code-paste flow state
  const [codePasteFlow, setCodePasteFlow] = useState<{
    provider: string
    auth_url: string
    code_verifier: string
    state: string
    pastedUrl: string
  } | null>(null)
  const [codePasteError, setCodePasteError] = useState<string | null>(null)
  const [codePasteSubmitting, setCodePasteSubmitting] = useState(false)

  const connected = searchParams.get("connected")
  const paramError = searchParams.get("error")

  // Fetch providers and credentials
  const fetchData = useCallback(async () => {
    try {
      const [provRes, credRes] = await Promise.allSettled([listProviders(), listCredentials()])

      if (provRes.status === "fulfilled") {
        setProviders(provRes.value.providers ?? [])
      }
      if (credRes.status === "fulfilled") {
        setCredentials(credRes.value.credentials ?? [])
      }
    } catch {
      // Silently fail — display empty state
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authStatus === "authenticated") void fetchData()
  }, [authStatus, fetchData])

  // Initiate code-paste flow
  const startCodePasteFlow = useCallback(async (provider: string) => {
    setCodePasteError(null)
    try {
      const data = await initOAuthConnect(provider)
      setCodePasteFlow({
        provider,
        auth_url: data.auth_url,
        code_verifier: data.code_verifier,
        state: data.state,
        pastedUrl: "",
      })
    } catch (err) {
      setCodePasteError(err instanceof Error ? err.message : "Failed to initialize OAuth flow")
    }
  }, [])

  // Submit code-paste exchange
  const submitCodePaste = useCallback(async () => {
    if (!codePasteFlow || !codePasteFlow.pastedUrl.trim()) return
    setCodePasteSubmitting(true)
    setCodePasteError(null)

    try {
      await exchangeOAuthConnect(codePasteFlow.provider, {
        pastedUrl: codePasteFlow.pastedUrl,
        code_verifier: codePasteFlow.code_verifier,
        state: codePasteFlow.state,
      })

      setCodePasteFlow(null)
      void fetchData()
    } catch (err) {
      setCodePasteError(
        err instanceof Error ? err.message : "Failed to exchange authorization code",
      )
    } finally {
      setCodePasteSubmitting(false)
    }
  }, [codePasteFlow, fetchData])

  // Connect OAuth provider (redirect-based, for providers with registered callbacks)
  const connectOAuth = useCallback((provider: string) => {
    window.location.href = `/api/auth/connect/${provider}`
  }, [])

  // Save API key
  const saveApiKey = useCallback(async () => {
    if (!apiKeyForm) return
    setSaving(true)
    setError(null)

    try {
      await saveProviderApiKey({
        provider: apiKeyForm.provider,
        apiKey: apiKeyForm.key,
        displayLabel: apiKeyForm.label || undefined,
      })

      setApiKeyForm(null)
      void fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save API key")
    } finally {
      setSaving(false)
    }
  }, [apiKeyForm, fetchData])

  // Delete credential
  const handleDeleteCredential = useCallback(
    async (id: string) => {
      try {
        await apiDeleteCredential(id)
      } catch {
        // Ignore — re-fetch will show current state
      }
      void fetchData()
    },
    [fetchData],
  )

  if (authStatus === "loading" || loading) {
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
            const isOAuth = p.auth_type === "oauth"
            const isCodePaste = CODE_PASTE_PROVIDER_IDS.has(p.id)

            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-surface-border p-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-main">{p.name}</span>
                    {cred ? (
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
                    ) : (
                      <span className="inline-block rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase text-text-muted">
                        Not Connected
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-muted">{p.description}</p>
                  {cred?.masked_key && (
                    <p className="mt-1 font-mono text-xs text-text-muted">{cred.masked_key}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {cred ? (
                    <button
                      type="button"
                      onClick={() => void handleDeleteCredential(cred.id)}
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
                    >
                      Disconnect
                    </button>
                  ) : isOAuth && isCodePaste ? (
                    <button
                      type="button"
                      onClick={() => void startCodePasteFlow(p.id)}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-content hover:bg-primary/90 transition-colors"
                    >
                      Connect
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

      {/* Code-paste flow dialog */}
      {codePasteFlow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-lg rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-text-main">
              Connect {providers.find((p) => p.id === codePasteFlow.provider)?.name}
            </h3>

            <div className="mt-3 space-y-4">
              <div>
                <p className="text-sm text-text-muted">
                  1. Click the link below to open the authorization page in a new tab.
                </p>
                <a
                  href={codePasteFlow.auth_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-sm font-medium text-primary hover:underline break-all"
                >
                  Open authorization page
                </a>
              </div>

              <div>
                <p className="text-sm text-text-muted">
                  2. After authorizing, copy the URL from your browser address bar and paste it
                  below.
                </p>
              </div>

              {codePasteError && (
                <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {codePasteError}
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Paste redirect URL here
                </label>
                <input
                  type="text"
                  value={codePasteFlow.pastedUrl}
                  onChange={(e) =>
                    setCodePasteFlow((f) => (f ? { ...f, pastedUrl: e.target.value } : f))
                  }
                  className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="http://localhost:..."
                  autoFocus
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCodePasteFlow(null)
                  setCodePasteError(null)
                }}
                className="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitCodePaste()}
                disabled={codePasteSubmitting || !codePasteFlow.pastedUrl.trim()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-content hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {codePasteSubmitting ? "Connecting..." : "Connect"}
              </button>
            </div>
          </div>
        </div>
      )}

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
