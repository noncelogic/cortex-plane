"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import { useAuth } from "@/components/auth-provider"
import {
  type AgentCredentialBinding,
  bindAgentCredential,
  type Credential,
  listAgentCredentials,
  listCredentials,
  unbindAgentCredential,
} from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classIcon(credClass: string): string {
  if (credClass === "llm_provider") return "psychology"
  if (credClass === "user_service") return "key"
  if (credClass === "tool_specific") return "build"
  return "lock"
}

function classLabel(credClass: string): string {
  if (credClass === "llm_provider") return "LLM Provider"
  if (credClass === "user_service") return "User Service"
  if (credClass === "tool_specific") return "Tool Secret"
  return credClass
}

function statusBadge(status: string): {
  label: string
  className: string
} {
  switch (status) {
    case "active":
      return {
        label: "Active",
        className: "bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20",
      }
    case "expired":
      return {
        label: "Expired",
        className: "bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20",
      }
    case "error":
      return {
        label: "Error",
        className: "bg-red-500/10 text-red-400 ring-1 ring-red-500/20",
      }
    case "revoked":
      return {
        label: "Revoked",
        className: "bg-slate-500/10 text-slate-400 ring-1 ring-slate-500/20",
      }
    default:
      return {
        label: status,
        className: "bg-slate-500/10 text-slate-400 ring-1 ring-slate-500/20",
      }
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CredentialClassBadge({ credClass }: { credClass: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
      <span className="material-symbols-outlined text-[12px]">{classIcon(credClass)}</span>
      {classLabel(credClass)}
    </span>
  )
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const { label, className } = statusBadge(status)
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${className}`}>
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Unbind confirmation dialog
// ---------------------------------------------------------------------------

interface UnbindDialogProps {
  binding: AgentCredentialBinding
  onConfirm: () => void
  onCancel: () => void
  isLoading: boolean
}

function UnbindDialog({
  binding,
  onConfirm,
  onCancel,
  isLoading,
}: UnbindDialogProps): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative mx-4 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-red-500/10">
            <span className="material-symbols-outlined text-xl text-red-500">link_off</span>
          </div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Unbind Credential</h3>
        </div>
        <p className="mb-6 text-sm text-slate-500">
          Remove <strong>{binding.displayLabel ?? binding.provider}</strong> from this agent? The
          credential itself will not be deleted.
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50"
          >
            {isLoading ? "Removing…" : "Unbind"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Credential picker modal
// ---------------------------------------------------------------------------

interface PickerModalProps {
  available: Credential[]
  boundIds: Set<string>
  isAdmin: boolean
  isLoading: boolean
  onSelect: (credentialId: string) => void
  onClose: () => void
}

function PickerModal({
  available,
  boundIds,
  isAdmin,
  isLoading,
  onSelect,
  onClose,
}: PickerModalProps): React.JSX.Element {
  const [filter, setFilter] = useState("")

  const filtered = useMemo(() => {
    const q = filter.toLowerCase()
    return available.filter((c) => {
      // Non-admins don't see tool_specific credentials
      if (c.credentialType === "tool_specific" && !isAdmin) return false
      if (!q) return true
      return (
        c.provider.toLowerCase().includes(q) ||
        (c.displayLabel ?? "").toLowerCase().includes(q) ||
        c.credentialType.toLowerCase().includes(q)
      )
    })
  }, [available, filter, isAdmin])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative mx-4 w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg text-primary">add_link</span>
            <h3 className="font-bold text-white">Bind Credential</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-slate-700 px-5 py-3">
          <div className="flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2">
            <span className="material-symbols-outlined text-sm text-slate-400">search</span>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by provider…"
              className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 focus:outline-none"
              autoFocus
            />
          </div>
        </div>

        {/* List */}
        <div className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <span className="material-symbols-outlined mb-2 text-2xl text-slate-600">
                search_off
              </span>
              <p className="text-sm text-slate-500">
                {available.length === 0
                  ? "No credentials available. Add credentials in Settings."
                  : "No credentials match your filter."}
              </p>
            </div>
          ) : (
            filtered.map((cred) => {
              const alreadyBound = boundIds.has(cred.id)
              return (
                <button
                  key={cred.id}
                  onClick={() => !alreadyBound && onSelect(cred.id)}
                  disabled={alreadyBound || isLoading}
                  className={`w-full rounded-lg px-4 py-3 text-left transition-colors ${
                    alreadyBound
                      ? "cursor-not-allowed opacity-50"
                      : "hover:bg-slate-800 active:bg-slate-700"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                        <span className="material-symbols-outlined text-sm text-primary">
                          {classIcon(cred.credentialType)}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">
                          {cred.displayLabel ?? cred.provider}
                        </p>
                        <p className="text-xs text-slate-400">{cred.provider}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <CredentialClassBadge credClass={cred.credentialType} />
                      {alreadyBound && (
                        <span className="text-xs font-medium text-emerald-400">Bound</span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-700 px-5 py-3">
          <p className="text-[11px] text-slate-500">
            Only active credentials can be bound. Manage credentials in{" "}
            <a href="/settings" className="text-primary underline-offset-2 hover:underline">
              Settings
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bindings table row
// ---------------------------------------------------------------------------

interface BindingRowProps {
  binding: AgentCredentialBinding
  onUnbind: (binding: AgentCredentialBinding) => void
}

function BindingRow({ binding, onUnbind }: BindingRowProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-primary/10 dark:bg-primary/5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <span className="material-symbols-outlined text-base text-primary">
            {classIcon(binding.credentialClass)}
          </span>
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
            {binding.displayLabel ?? binding.provider}
          </p>
          <p className="text-xs text-slate-500">{binding.provider}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <CredentialClassBadge credClass={binding.credentialClass} />
        <StatusBadge status={binding.status} />
        <button
          onClick={() => onUnbind(binding)}
          title="Unbind credential"
          className="flex size-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
        >
          <span className="material-symbols-outlined text-lg">link_off</span>
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface CredentialBindingPanelProps {
  agentId: string
}

export function CredentialBindingPanel({
  agentId,
}: CredentialBindingPanelProps): React.JSX.Element {
  const { user } = useAuth()
  const isAdmin = user?.role === "admin"

  const [bindings, setBindings] = useState<AgentCredentialBinding[]>([])
  const [available, setAvailable] = useState<Credential[]>([])
  const [loadingBindings, setLoadingBindings] = useState(true)
  const [loadingAvailable, setLoadingAvailable] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [showPicker, setShowPicker] = useState(false)
  const [bindingInProgress, setBindingInProgress] = useState(false)
  const [unbindTarget, setUnbindTarget] = useState<AgentCredentialBinding | null>(null)
  const [unbindingInProgress, setUnbindingInProgress] = useState(false)

  const fetchBindings = useCallback(async () => {
    setLoadingBindings(true)
    setError(null)
    try {
      const res = await listAgentCredentials(agentId)
      setBindings(res.bindings)
    } catch {
      setError("Failed to load credentials")
    } finally {
      setLoadingBindings(false)
    }
  }, [agentId])

  useEffect(() => {
    void fetchBindings()
  }, [fetchBindings])

  const handleOpenPicker = useCallback(async () => {
    setLoadingAvailable(true)
    try {
      const res = await listCredentials()
      setAvailable(res.credentials)
    } catch {
      setAvailable([])
    } finally {
      setLoadingAvailable(false)
    }
    setShowPicker(true)
  }, [])

  const handleBind = useCallback(
    async (credentialId: string) => {
      setBindingInProgress(true)
      try {
        await bindAgentCredential(agentId, credentialId)
        setShowPicker(false)
        await fetchBindings()
      } catch {
        // surface error in picker area; keep picker open
      } finally {
        setBindingInProgress(false)
      }
    },
    [agentId, fetchBindings],
  )

  const handleUnbind = useCallback(async () => {
    if (!unbindTarget) return
    setUnbindingInProgress(true)
    try {
      await unbindAgentCredential(agentId, unbindTarget.credentialId)
      setUnbindTarget(null)
      await fetchBindings()
    } catch {
      // noop — the confirmation dialog stays open
    } finally {
      setUnbindingInProgress(false)
    }
  }, [agentId, unbindTarget, fetchBindings])

  const boundIds = useMemo(() => new Set(bindings.map((b) => b.credentialId)), [bindings])

  return (
    <div className="flex flex-col gap-4">
      {/* Panel header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">lock</span>
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
            Credentials
          </h3>
        </div>
        <button
          onClick={() => void handleOpenPicker()}
          disabled={loadingAvailable}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">add_link</span>
          {loadingAvailable ? "Loading…" : "Bind credential"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3">
          <span className="material-symbols-outlined text-lg text-red-400">error</span>
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loadingBindings ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-700/50"
            />
          ))}
        </div>
      ) : bindings.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 py-10 dark:border-slate-700">
          <span className="material-symbols-outlined mb-3 text-3xl text-slate-500">lock_open</span>
          <p className="mb-1 text-sm font-medium text-slate-400">No credentials bound</p>
          <p className="text-xs text-slate-500">
            Bind a credential so this agent can access external services.
          </p>
        </div>
      ) : (
        /* Bindings list */
        <div className="space-y-2">
          {bindings.map((b) => (
            <BindingRow key={b.id} binding={b} onUnbind={setUnbindTarget} />
          ))}
        </div>
      )}

      {/* Unbind confirmation */}
      {unbindTarget && (
        <UnbindDialog
          binding={unbindTarget}
          onConfirm={() => void handleUnbind()}
          onCancel={() => setUnbindTarget(null)}
          isLoading={unbindingInProgress}
        />
      )}

      {/* Credential picker */}
      {showPicker && (
        <PickerModal
          available={available}
          boundIds={boundIds}
          isAdmin={isAdmin}
          isLoading={bindingInProgress}
          onSelect={(id) => void handleBind(id)}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}
