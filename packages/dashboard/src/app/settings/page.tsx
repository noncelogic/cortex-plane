"use client"

import { useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useState } from "react"

import { useAuth } from "@/components/auth-provider"
import { useToast } from "@/components/layout/toast"
import { ChannelConfigSection } from "@/components/settings/channel-config-section"
import { useOAuthPopup } from "@/hooks/use-oauth-popup"
import {
  type Credential,
  deleteCredential as apiDeleteCredential,
  exchangeOAuthConnect,
  listCredentials,
  listProviders,
  type ProviderInfo,
  saveProviderApiKey,
} from "@/lib/api-client"
import { errorSummary, refreshStatus, tokenExpiry } from "@/lib/credential-health"

/** Find a human-readable label for a credential (provider name or display label). */
function credentialLabel(cred: Credential, providers: ProviderInfo[]): string {
  if (cred.displayLabel) return cred.displayLabel
  return providers.find((p) => p.id === cred.provider)?.name ?? cred.provider
}

/** Render credential health details (errors, token expiry, refresh status). */
function CredentialHealthDetails({ cred }: { cred: Credential }) {
  const err = errorSummary(cred)
  const expiry = tokenExpiry(cred)
  const refresh = refreshStatus(cred)

  const hasDetails = err || expiry || refresh || cred.lastUsedAt
  if (!hasDetails) return null

  return (
    <div className="mt-1.5 space-y-0.5 text-xs">
      {cred.lastUsedAt && (
        <p className="text-text-muted">Last used: {new Date(cred.lastUsedAt).toLocaleString()}</p>
      )}
      {expiry && (
        <p
          className={
            expiry.severity === "danger"
              ? "text-danger"
              : expiry.severity === "warning"
                ? "text-warning"
                : "text-text-muted"
          }
        >
          {expiry.label}
        </p>
      )}
      {refresh && <p className="text-text-muted">{refresh}</p>}
      {err && (
        <div className="mt-1 rounded border border-danger/20 bg-danger/5 px-2 py-1">
          <p className="font-medium text-danger">{err.label}</p>
          {err.message && <p className="mt-0.5 text-text-muted">{err.message}</p>}
        </div>
      )}
    </div>
  )
}

/** Code-paste providers that use the init/exchange flow (Anthropic only — device code). */
const CODE_PASTE_PROVIDER_IDS = new Set(["anthropic"])

/**
 * Providers that display a device code instead of redirecting to localhost.
 * For these, we skip the popup entirely and show a code-paste input immediately.
 */
const CODE_PASTE_ONLY_PROVIDER_IDS = new Set(["anthropic"])

// ---------------------------------------------------------------------------
// Settings page inner (wrapped in Suspense)
// ---------------------------------------------------------------------------

function SettingsInner() {
  const { user, authStatus } = useAuth()
  const { addToast } = useToast()
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

  // Disconnect credential state
  const [disconnectConfirm, setDisconnectConfirm] = useState<{
    id: string
    label: string
  } | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)

  // Code-paste fallback state (shown when popup cannot read the redirect URL)
  const [popupProvider, setPopupProvider] = useState<string | null>(null)
  const [codePastePastedUrl, setCodePastePastedUrl] = useState("")
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
      } else {
        addToast("Failed to load providers", "error")
      }
      if (credRes.status === "fulfilled") {
        setCredentials(credRes.value.credentials ?? [])
      } else {
        addToast("Failed to load credentials", "error")
      }
    } catch {
      addToast("Failed to load settings data", "error")
    } finally {
      setLoading(false)
    }
  }, [addToast])

  // Popup OAuth flow (progressive enhancement over code-paste)
  const popup = useOAuthPopup(() => void fetchData())

  useEffect(() => {
    if (authStatus === "authenticated") void fetchData()
  }, [authStatus, fetchData])

  // Start popup OAuth flow (falls back to code-paste if popup is blocked or URL unreadable).
  // For code-paste-only providers (e.g. Anthropic), skip the popup entirely.
  const startPopupFlow = useCallback(
    async (provider: string) => {
      setCodePasteError(null)
      setCodePastePastedUrl("")
      setPopupProvider(provider)
      const skipPopup = CODE_PASTE_ONLY_PROVIDER_IDS.has(provider)
      await popup.startFlow(provider, { skipPopup })
    },
    [popup],
  )

  // Submit code-paste exchange (fallback path)
  const submitCodePaste = useCallback(async () => {
    if (!popup.fallbackContext || !popupProvider || !codePastePastedUrl.trim()) return
    setCodePasteSubmitting(true)
    setCodePasteError(null)

    try {
      await exchangeOAuthConnect(popupProvider, {
        pastedUrl: codePastePastedUrl,
        codeVerifier: popup.fallbackContext.codeVerifier,
        state: popup.fallbackContext.state,
      })

      popup.cancel()
      setPopupProvider(null)
      setCodePastePastedUrl("")
      addToast("Provider connected successfully", "success")
      void fetchData()
    } catch (err) {
      setCodePasteError(
        err instanceof Error ? err.message : "Failed to exchange authorization code",
      )
    } finally {
      setCodePasteSubmitting(false)
    }
  }, [popup, popupProvider, codePastePastedUrl, fetchData])

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
      addToast("API key saved successfully", "success")
      void fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save API key")
    } finally {
      setSaving(false)
    }
  }, [apiKeyForm, fetchData, addToast])

  // Delete credential (called after user confirms)
  const handleDeleteCredential = useCallback(
    async (id: string) => {
      setDisconnecting(true)
      setError(null)
      try {
        await apiDeleteCredential(id)
        setDisconnectConfirm(null)
        addToast("Credential disconnected", "success")
        void fetchData()
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to disconnect credential"
        setError(msg)
        addToast(msg, "error")
        setDisconnectConfirm(null)
      } finally {
        setDisconnecting(false)
      }
    },
    [fetchData, addToast],
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

  // Split providers by credential class for separate UI sections.
  const llmProviders = providers.filter(
    (p) => !p.credentialClass || p.credentialClass === "llm_provider",
  )
  const userServiceProviders = providers.filter((p) => p.credentialClass === "user_service")

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
      {(codePasteError ?? popup.error) && popup.status === "idle" && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {codePasteError ?? popup.error}
        </div>
      )}

      {/* Connected Providers */}
      <section className="rounded-xl border border-surface-border bg-surface-light p-6">
        <h2 className="text-lg font-semibold text-text-main">Connected Providers</h2>
        <p className="mt-1 text-sm text-text-muted">
          Connect your LLM provider accounts. Credentials are encrypted with AES-256-GCM.
        </p>

        {error && !apiKeyForm && (
          <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="mt-4 space-y-3">
          {llmProviders.map((p) => {
            const cred = getCredentialForProvider(p.id)
            const isOAuth = p.authType === "oauth"
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
                  {cred?.maskedKey && (
                    <p className="mt-1 font-mono text-xs text-text-muted">{cred.maskedKey}</p>
                  )}
                  {cred?.accountId && (
                    <p className="mt-1 text-xs text-text-muted">
                      Project: <span className="font-mono">{cred.accountId}</span>
                    </p>
                  )}
                  {cred && <CredentialHealthDetails cred={cred} />}
                  {p.models && p.models.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {p.models.map((m) => (
                        <span
                          key={m.id}
                          className="inline-block rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
                        >
                          {m.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {cred ? (
                    <button
                      type="button"
                      onClick={() =>
                        setDisconnectConfirm({
                          id: cred.id,
                          label: credentialLabel(cred, providers),
                        })
                      }
                      className="rounded-lg px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
                    >
                      Disconnect
                    </button>
                  ) : isOAuth && isCodePaste ? (
                    <button
                      type="button"
                      onClick={() => void startPopupFlow(p.id)}
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

          {llmProviders.length === 0 && (
            <p className="py-4 text-center text-sm text-text-muted">
              No LLM providers configured. Configure provider credentials in the control plane.
            </p>
          )}
        </div>
      </section>

      {/* Connected Services (user_service providers) */}
      {userServiceProviders.length > 0 && (
        <section className="rounded-xl border border-surface-border bg-surface-light p-6">
          <h2 className="text-lg font-semibold text-text-main">Connected Services</h2>
          <p className="mt-1 text-sm text-text-muted">
            Connect third-party services so agents can act on your behalf.
          </p>

          <div className="mt-4 space-y-3">
            {userServiceProviders.map((p) => {
              const cred = getCredentialForProvider(p.id)
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
                          {cred.status === "active" ? "Connected" : cred.status}
                        </span>
                      ) : (
                        <span className="inline-block rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase text-text-muted">
                          Not Connected
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted">{p.description}</p>
                    {cred && <CredentialHealthDetails cred={cred} />}
                  </div>

                  <div className="flex items-center gap-2">
                    {cred ? (
                      <button
                        type="button"
                        onClick={() =>
                          setDisconnectConfirm({
                            id: cred.id,
                            label: credentialLabel(cred, providers),
                          })
                        }
                        className="rounded-lg px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
                      >
                        Disconnect
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => connectOAuth(p.id)}
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-content hover:bg-primary/90 transition-colors"
                      >
                        Connect
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Channels */}
      <ChannelConfigSection />

      {/* Disconnect credential confirmation dialog */}
      {disconnectConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-text-main">Disconnect Provider</h3>
            <p className="mt-2 text-sm text-text-muted">
              Are you sure you want to disconnect
              <strong> &ldquo;{disconnectConfirm.label}&rdquo;</strong>?
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDisconnectConfirm(null)}
                disabled={disconnecting}
                className="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteCredential(disconnectConfirm.id)}
                disabled={disconnecting}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50 transition-colors"
              >
                {disconnecting ? "Disconnecting..." : "Disconnect"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OAuth popup / code-paste fallback dialog */}
      {popupProvider && popup.status !== "idle" && popup.status !== "success" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-lg rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-text-main">
              Connect {providers.find((p) => p.id === popupProvider)?.name}
            </h3>

            <div className="mt-3 space-y-4">
              {popup.status === "waiting" && (
                <div className="flex items-center gap-3">
                  <div className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  <p className="text-sm text-text-muted">
                    Waiting for authorization in the popup window...
                  </p>
                </div>
              )}

              {popup.status === "fallback" && popup.fallbackContext && (
                <>
                  {popupProvider && CODE_PASTE_ONLY_PROVIDER_IDS.has(popupProvider) ? (
                    <>
                      <div>
                        <p className="text-sm text-text-muted">
                          1. Click the link below to open the authorization page.
                        </p>
                        <a
                          href={popup.fallbackContext.authUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-block text-sm font-medium text-primary hover:underline break-all"
                        >
                          Open authorization page
                        </a>
                      </div>

                      <div>
                        <p className="text-sm text-text-muted">
                          2. Authorize the application, then copy the device code shown on the page.
                        </p>
                      </div>

                      <div>
                        <p className="text-sm text-text-muted">3. Paste the device code below.</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <p className="text-sm text-text-muted">
                          The popup could not capture the redirect automatically. Please complete
                          authorization and paste the redirect URL below.
                        </p>
                      </div>

                      <div>
                        <p className="text-sm text-text-muted">
                          1. Open the authorization page (if not already open).
                        </p>
                        <a
                          href={popup.fallbackContext.authUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-block text-sm font-medium text-primary hover:underline break-all"
                        >
                          Open authorization page
                        </a>
                      </div>

                      <div>
                        <p className="text-sm text-text-muted">
                          2. After authorizing, copy the URL from your browser address bar and paste
                          it below.
                        </p>
                      </div>
                    </>
                  )}

                  {(codePasteError ?? popup.error) && (
                    <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                      {codePasteError ?? popup.error}
                    </div>
                  )}

                  <div>
                    <label className="mb-1 block text-xs font-medium text-text-muted">
                      {popupProvider && CODE_PASTE_ONLY_PROVIDER_IDS.has(popupProvider)
                        ? "Paste device code here"
                        : "Paste redirect URL here"}
                    </label>
                    <input
                      type="text"
                      value={codePastePastedUrl}
                      onChange={(e) => setCodePastePastedUrl(e.target.value)}
                      className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder={
                        popupProvider && CODE_PASTE_ONLY_PROVIDER_IDS.has(popupProvider)
                          ? "e.g. authcode123#state456"
                          : "http://localhost:..."
                      }
                      autoFocus
                    />
                  </div>
                </>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  popup.cancel()
                  setPopupProvider(null)
                  setCodePasteError(null)
                  setCodePastePastedUrl("")
                }}
                className="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              {popup.status === "fallback" && (
                <button
                  type="button"
                  onClick={() => void submitCodePaste()}
                  disabled={codePasteSubmitting || !codePastePastedUrl.trim()}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-content hover:bg-primary/90 disabled:opacity-50 transition-colors"
                >
                  {codePasteSubmitting ? "Connecting..." : "Connect"}
                </button>
              )}
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
