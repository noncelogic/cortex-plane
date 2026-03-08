"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  type AgentSummary,
  ApiError,
  bindAgentChannel,
  type BindingWithAgent,
  type ChannelConfigSummary,
  createChannelConfig,
  deleteChannelConfig,
  listAgents,
  listChannelBindings,
  listChannelConfigs,
  unbindAgentChannel,
  updateChannelConfig,
} from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Channel type metadata
// ---------------------------------------------------------------------------

const CHANNEL_TYPES = [
  { id: "telegram", label: "Telegram", fields: ["botToken"] },
  { id: "discord", label: "Discord", fields: ["token", "guildIds"] },
  { id: "whatsapp", label: "WhatsApp", fields: ["apiKey", "phoneNumberId"] },
] as const

type ChannelTypeId = (typeof CHANNEL_TYPES)[number]["id"]

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface AddChannelForm {
  type: ChannelTypeId
  name: string
  config: Record<string, string>
}

const EMPTY_FORM: AddChannelForm = { type: "telegram", name: "", config: {} }

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChannelConfigSection() {
  const [channels, setChannels] = useState<ChannelConfigSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<AddChannelForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{
    id: string
    name: string
    conflict?: string
    boundAgents?: string[]
  } | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Expanded channel cards showing their bindings
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [channelBindings, setChannelBindings] = useState<Record<string, BindingWithAgent[]>>({})
  const [loadingBindings, setLoadingBindings] = useState<string | null>(null)

  // Bind-to-agent modal
  const [bindTarget, setBindTarget] = useState<ChannelConfigSummary | null>(null)
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [loadingAgents, setLoadingAgents] = useState(false)
  const [bindForm, setBindForm] = useState({ agentId: "", chatId: "", isDefault: false })
  const [binding, setBinding] = useState(false)
  const [bindError, setBindError] = useState<string | null>(null)

  const fetchChannels = useCallback(async () => {
    try {
      const res = await listChannelConfigs()
      setChannels(res.channels ?? [])
    } catch {
      // API may not be available if CREDENTIAL_MASTER_KEY is not set
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchChannels()
  }, [fetchChannels])

  const fetchBindingsForChannel = useCallback(async (channelId: string) => {
    setLoadingBindings(channelId)
    try {
      const res = await listChannelBindings(channelId)
      setChannelBindings((prev) => ({ ...prev, [channelId]: res.bindings ?? [] }))
    } catch {
      setChannelBindings((prev) => ({ ...prev, [channelId]: [] }))
    } finally {
      setLoadingBindings(null)
    }
  }, [])

  const handleToggleExpand = useCallback(
    (ch: ChannelConfigSummary) => {
      if (expandedId === ch.id) {
        setExpandedId(null)
        return
      }
      setExpandedId(ch.id)
      void fetchBindingsForChannel(ch.id)
    },
    [expandedId, fetchBindingsForChannel],
  )

  const handleCreate = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      await createChannelConfig({
        type: form.type,
        name: form.name,
        config: form.config,
      })
      setShowAdd(false)
      setForm(EMPTY_FORM)
      void fetchChannels()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create channel")
    } finally {
      setSaving(false)
    }
  }, [form, fetchChannels])

  const handleToggle = useCallback(
    async (ch: ChannelConfigSummary) => {
      try {
        await updateChannelConfig(ch.id, { enabled: !ch.enabled })
        void fetchChannels()
      } catch {
        // silent
      }
    },
    [fetchChannels],
  )

  const handleDelete = useCallback(
    async (id: string, force?: boolean) => {
      setDeleting(true)
      setError(null)
      try {
        await deleteChannelConfig(id, force ? { force: true } : undefined)
        setDeleteConfirm(null)
        if (expandedId === id) setExpandedId(null)
        void fetchChannels()
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const ch = channels.find((c) => c.id === id)
          // Fetch bound agents to display in the confirmation dialog
          let boundAgents: string[] = []
          try {
            const res = await listChannelBindings(id)
            const agentNames = [...new Set(res.bindings.map((b) => b.agent_name))]
            boundAgents = agentNames
          } catch {
            // fall back to generic conflict message
          }
          setDeleteConfirm({
            id,
            name: ch?.name ?? id,
            conflict: err.message,
            boundAgents,
          })
        } else {
          setError(err instanceof Error ? err.message : "Failed to delete channel")
        }
      } finally {
        setDeleting(false)
      }
    },
    [fetchChannels, channels, expandedId],
  )

  const handleOpenBindModal = useCallback(async (ch: ChannelConfigSummary) => {
    setBindTarget(ch)
    setBindForm({ agentId: "", chatId: "", isDefault: false })
    setBindError(null)
    setLoadingAgents(true)
    try {
      const res = await listAgents({ status: "ACTIVE" })
      setAgents(res.agents ?? [])
    } catch {
      setAgents([])
    } finally {
      setLoadingAgents(false)
    }
  }, [])

  const handleBind = useCallback(async () => {
    if (!bindTarget || !bindForm.agentId || !bindForm.chatId.trim()) return
    setBinding(true)
    setBindError(null)
    try {
      await bindAgentChannel(bindForm.agentId, bindTarget.type, bindForm.chatId.trim())
      setBindTarget(null)
      // Refresh bindings for the expanded channel
      if (expandedId) {
        void fetchBindingsForChannel(expandedId)
      }
    } catch (err) {
      setBindError(err instanceof Error ? err.message : "Failed to bind channel")
    } finally {
      setBinding(false)
    }
  }, [bindTarget, bindForm, expandedId, fetchBindingsForChannel])

  const handleUnbindFromChannel = useCallback(
    async (b: BindingWithAgent) => {
      try {
        await unbindAgentChannel(b.agent_id, b.id)
        if (expandedId) {
          void fetchBindingsForChannel(expandedId)
        }
      } catch {
        // silent
      }
    },
    [expandedId, fetchBindingsForChannel],
  )

  const isDuplicate = useMemo(
    () =>
      form.name.trim() !== "" &&
      channels.some((ch) => ch.type === form.type && ch.name === form.name.trim()),
    [channels, form.type, form.name],
  )

  const selectedType = CHANNEL_TYPES.find((t) => t.id === form.type)!

  if (loading) {
    return (
      <section className="rounded-xl border border-surface-border bg-surface-light p-6">
        <h2 className="text-lg font-semibold text-text-main">Channels</h2>
        <div className="mt-4 flex justify-center py-4">
          <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-surface-border bg-surface-light p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-text-main">Channels</h2>
          <p className="mt-1 text-sm text-text-muted">
            Configure chat channel adapters. Bot tokens are encrypted at rest.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-content hover:bg-primary/90 transition-colors"
        >
          Add Channel
        </button>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Channel list */}
      <div className="mt-4 space-y-3">
        {channels.map((ch) => {
          const isExpanded = expandedId === ch.id
          const bindings = channelBindings[ch.id] ?? []
          const isLoadingThisBindings = loadingBindings === ch.id

          return (
            <div key={ch.id} className="rounded-lg border border-surface-border">
              {/* Channel header row */}
              <div className="flex items-center justify-between p-4">
                <button
                  type="button"
                  onClick={() => handleToggleExpand(ch)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-sm text-text-muted">
                      {isExpanded ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="text-sm font-semibold text-text-main">{ch.name}</span>
                    <span className="inline-block rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase text-text-muted">
                      {ch.type}
                    </span>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${ch.enabled ? "bg-success/10 text-success" : "bg-secondary text-text-muted"}`}
                    >
                      {ch.enabled ? "Enabled" : "Disabled"}
                    </span>
                    {isExpanded && bindings.length > 0 && (
                      <span className="inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                        {bindings.length} binding{bindings.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  {ch.bot_metadata?.username && (
                    <p className="mt-1 ml-6 text-xs text-text-muted">
                      Bot: @{ch.bot_metadata.username}
                      {ch.bot_metadata.display_name ? ` (${ch.bot_metadata.display_name})` : ""}
                    </p>
                  )}
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleOpenBindModal(ch)}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
                  >
                    Bind to Agent
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleToggle(ch)}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-secondary transition-colors"
                  >
                    {ch.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm({ id: ch.id, name: ch.name })}
                    className="rounded-lg px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>

              {/* Expanded bindings panel */}
              {isExpanded && (
                <div className="border-t border-surface-border bg-surface-dark/30 px-4 py-3">
                  {isLoadingThisBindings ? (
                    <div className="flex justify-center py-3">
                      <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    </div>
                  ) : bindings.length === 0 ? (
                    <p className="py-2 text-center text-xs text-text-muted">
                      No agents bound to this channel type. Click &ldquo;Bind to Agent&rdquo; to
                      create a binding.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                        Agent Bindings
                      </p>
                      {bindings.map((b) => (
                        <div
                          key={b.id}
                          className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-light px-3 py-2"
                        >
                          <div className="flex items-center gap-2">
                            <a
                              href={`/agents/${b.agent_id}`}
                              className="text-sm font-medium text-primary hover:underline"
                            >
                              {b.agent_name}
                            </a>
                            <span className="font-mono text-xs text-text-muted">{b.chat_id}</span>
                            {b.is_default && (
                              <span className="inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase text-primary">
                                Default
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleUnbindFromChannel(b)}
                            className="rounded-lg px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
                          >
                            Unbind
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {channels.length === 0 && (
          <p className="py-4 text-center text-sm text-text-muted">
            No channels configured. Add a Telegram, Discord, or WhatsApp channel to get started.
          </p>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-text-main">Remove Channel</h3>
            {deleteConfirm.conflict ? (
              <div className="mt-2">
                <p className="text-sm text-text-muted">{deleteConfirm.conflict}</p>
                {deleteConfirm.boundAgents && deleteConfirm.boundAgents.length > 0 && (
                  <div className="mt-2 rounded-lg border border-surface-border bg-surface-dark p-2">
                    <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                      Bound agents that will be detached:
                    </p>
                    {deleteConfirm.boundAgents.map((name) => (
                      <p key={name} className="text-sm text-text-main">
                        {name}
                      </p>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-sm text-text-muted">
                  Force-remove to unbind all agents and delete this channel?
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-text-muted">
                Are you sure you want to remove
                <strong> &ldquo;{deleteConfirm.name}&rdquo;</strong>?
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                disabled={deleting}
                className="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(deleteConfirm.id, !!deleteConfirm.conflict)}
                disabled={deleting}
                className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:bg-danger/90 disabled:opacity-50 transition-colors"
              >
                {deleting ? "Removing..." : deleteConfirm.conflict ? "Force Remove" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add channel modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-text-main">Add Channel</h3>

            {error && (
              <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {error}
              </div>
            )}

            <div className="mt-4 space-y-3">
              {/* Channel type */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Channel Type
                </label>
                <select
                  value={form.type}
                  onChange={(e) =>
                    setForm({ ...form, type: e.target.value as ChannelTypeId, config: {} })
                  }
                  className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {CHANNEL_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Name */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className={`w-full rounded-lg border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:outline-none focus:ring-1 ${isDuplicate ? "border-danger focus:border-danger focus:ring-danger" : "border-surface-border focus:border-primary focus:ring-primary"}`}
                  placeholder="e.g., Production Telegram Bot"
                />
                {isDuplicate && (
                  <p className="mt-1 text-xs text-danger">
                    A {form.type} channel with this name already exists.
                  </p>
                )}
              </div>

              {/* Dynamic config fields based on type */}
              {selectedType.fields.map((field) => (
                <div key={field}>
                  <label className="mb-1 block text-xs font-medium text-text-muted">
                    {formatFieldLabel(field)}
                  </label>
                  <input
                    type={isSecretField(field) ? "password" : "text"}
                    value={form.config[field] ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, config: { ...form.config, [field]: e.target.value } })
                    }
                    className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder={getFieldPlaceholder(field)}
                  />
                </div>
              ))}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false)
                  setForm(EMPTY_FORM)
                  setError(null)
                }}
                className="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={saving || !form.name.trim() || isDuplicate}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-content hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving..." : "Add Channel"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bind to agent modal */}
      {bindTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-text-main">Bind to Agent</h3>
            <p className="mt-1 text-xs text-text-muted">
              Route messages from <strong>{bindTarget.name}</strong> ({bindTarget.type}) to an
              agent.
            </p>

            {bindError && (
              <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {bindError}
              </div>
            )}

            <div className="mt-4 space-y-3">
              {/* Agent selector */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">Agent</label>
                {loadingAgents ? (
                  <div className="flex justify-center py-3">
                    <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  </div>
                ) : agents.length === 0 ? (
                  <p className="text-xs text-text-muted">No active agents available.</p>
                ) : (
                  <select
                    value={bindForm.agentId}
                    onChange={(e) => setBindForm({ ...bindForm, agentId: e.target.value })}
                    className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    <option value="">Select an agent...</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.slug})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Chat ID */}
              <div>
                <label className="mb-1 block text-xs font-medium text-text-muted">
                  Chat ID
                  {bindTarget.type === "telegram" && (
                    <span className="ml-1 text-text-muted/70">(Telegram group/user ID)</span>
                  )}
                </label>
                <input
                  type="text"
                  value={bindForm.chatId}
                  onChange={(e) => setBindForm({ ...bindForm, chatId: e.target.value })}
                  className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="e.g., -1001234567890"
                />
              </div>

              {/* Default checkbox */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={bindForm.isDefault}
                  onChange={(e) => setBindForm({ ...bindForm, isDefault: e.target.checked })}
                  className="size-4 rounded border-surface-border text-primary focus:ring-primary"
                />
                <span className="text-xs text-text-muted">
                  Set as default binding for {bindTarget.type}
                </span>
              </label>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBindTarget(null)}
                className="rounded-lg px-4 py-2 text-sm text-text-muted hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleBind()}
                disabled={binding || !bindForm.agentId || !bindForm.chatId.trim()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-content hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                {binding ? "Binding..." : "Bind"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    botToken: "Bot Token",
    token: "Bot Token",
    guildIds: "Guild IDs (comma-separated)",
    apiKey: "API Key",
    phoneNumberId: "Phone Number ID",
  }
  return labels[field] ?? field
}

function getFieldPlaceholder(field: string): string {
  const placeholders: Record<string, string> = {
    botToken: "123456:ABC-DEF...",
    token: "MTA2...",
    guildIds: "123456789012345678",
    apiKey: "your-api-key",
    phoneNumberId: "1234567890",
  }
  return placeholders[field] ?? ""
}

function isSecretField(field: string): boolean {
  return ["botToken", "token", "apiKey"].includes(field)
}
