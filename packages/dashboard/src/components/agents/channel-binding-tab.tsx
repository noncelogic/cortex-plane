"use client"

import { useCallback, useEffect, useState } from "react"

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
      // silent
    } finally {
      setLoading(false)
    }
  }, [agentId])

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
        // silent
      }
    },
    [agentId, fetchBindings],
  )

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Channel Bindings</h3>
          <p className="text-xs text-text-muted">
            Bind this agent to chat channels so it receives messages.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-content hover:bg-primary/90 transition-colors"
        >
          Bind Channel
        </button>
      </div>

      {/* Existing bindings */}
      <div className="space-y-2">
        {bindings.map((b) => (
          <div
            key={b.id}
            className="flex items-center justify-between rounded-lg border border-surface-border p-3"
          >
            <div className="flex items-center gap-2">
              <span className="inline-block rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase text-text-muted">
                {b.channel_type}
              </span>
              <span className="font-mono text-sm text-text-main">{b.chat_id}</span>
              {b.is_default && (
                <span className="inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase text-primary">
                  Default
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleUnbind(b.id)}
              className="rounded-lg px-3 py-1 text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
            >
              Unbind
            </button>
          </div>
        ))}

        {bindings.length === 0 && (
          <p className="py-4 text-center text-sm text-text-muted">
            No channels bound. Bind a channel to start receiving messages.
          </p>
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
