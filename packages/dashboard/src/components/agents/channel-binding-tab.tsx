"use client"

import { useCallback, useEffect, useState } from "react"

import { useToast } from "@/components/layout/toast"
import {
  type AgentChannelBinding,
  bindAgentChannel,
  listAgentChannels,
  unbindAgentChannel,
} from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ChannelBindingTabProps {
  agentId: string
}

const CHANNEL_TYPES = ["telegram", "discord", "whatsapp"] as const

export function ChannelBindingTab({ agentId }: ChannelBindingTabProps) {
  const { addToast } = useToast()
  const [bindings, setBindings] = useState<AgentChannelBinding[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [formType, setFormType] = useState("telegram")
  const [formChatId, setFormChatId] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchBindings = useCallback(async () => {
    try {
      const res = await listAgentChannels(agentId)
      setBindings(res.bindings ?? [])
    } catch {
      addToast("Failed to load channel bindings", "error")
    } finally {
      setLoading(false)
    }
  }, [agentId, addToast])

  useEffect(() => {
    void fetchBindings()
  }, [fetchBindings])

  const handleBind = useCallback(async () => {
    if (!formChatId.trim()) return
    setSaving(true)
    setError(null)
    try {
      await bindAgentChannel(agentId, formType, formChatId.trim())
      setShowAdd(false)
      setFormChatId("")
      void fetchBindings()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to bind channel")
    } finally {
      setSaving(false)
    }
  }, [agentId, formType, formChatId, fetchBindings])

  const handleUnbind = useCallback(
    async (bindingId: string) => {
      try {
        await unbindAgentChannel(agentId, bindingId)
        void fetchBindings()
      } catch {
        addToast("Failed to unbind channel", "error")
      }
    },
    [agentId, fetchBindings, addToast],
  )

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-primary/10 dark:bg-primary/5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">forum</span>
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
            Channel Bindings
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary/90"
        >
          <span className="material-symbols-outlined text-sm">add_link</span>
          Bind Channel
        </button>
      </div>

      {/* Existing bindings */}
      <div className="space-y-2">
        {bindings.map((b) => (
          <div
            key={b.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700/50 dark:bg-slate-800/50"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                {b.channel_type}
              </span>
              <span className="truncate font-mono text-sm text-slate-900 dark:text-white">
                {b.chat_id}
              </span>
              {b.is_default && (
                <span className="inline-flex rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400 ring-1 ring-emerald-500/20">
                  Default
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleUnbind(b.id)}
              title="Unbind channel"
              className="flex size-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
            >
              <span className="material-symbols-outlined text-lg">link_off</span>
            </button>
          </div>
        ))}

        {bindings.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 py-10 dark:border-slate-700">
            <span className="material-symbols-outlined mb-3 text-3xl text-slate-500">forum</span>
            <p className="mb-1 text-sm font-medium text-slate-400">No channels bound</p>
            <p className="text-xs text-slate-500">
              Bind a channel so this agent receives messages.
            </p>
          </div>
        )}
      </div>

      {/* Add binding modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-text-main">Bind Channel</h3>

            {error && (
              <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Channel Type
                </label>
                <select
                  value={formType}
                  onChange={(e) => setFormType(e.target.value)}
                  className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {CHANNEL_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">Chat ID</label>
                <input
                  type="text"
                  value={formChatId}
                  onChange={(e) => setFormChatId(e.target.value)}
                  className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="e.g., 123456789"
                  autoFocus
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false)
                  setFormChatId("")
                  setError(null)
                }}
                className="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleBind()}
                disabled={saving || !formChatId.trim()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-content hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {saving ? "Binding..." : "Bind"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
