"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  type ChannelConfigSummary,
  createChannelConfig,
  deleteChannelConfig,
  listChannelConfigs,
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
    async (id: string) => {
      try {
        await deleteChannelConfig(id)
        void fetchChannels()
      } catch {
        // silent
      }
    },
    [fetchChannels],
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

      {/* Channel list */}
      <div className="mt-4 space-y-3">
        {channels.map((ch) => (
          <div
            key={ch.id}
            className="flex items-center justify-between rounded-lg border border-surface-border p-4"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-text-main">{ch.name}</span>
                <span className="inline-block rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase text-text-muted">
                  {ch.type}
                </span>
                <span
                  className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${ch.enabled ? "bg-success/10 text-success" : "bg-secondary text-text-muted"}`}
                >
                  {ch.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleToggle(ch)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-muted hover:bg-secondary transition-colors"
              >
                {ch.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(ch.id)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        ))}

        {channels.length === 0 && (
          <p className="py-4 text-center text-sm text-text-muted">
            No channels configured. Add a Telegram, Discord, or WhatsApp channel to get started.
          </p>
        )}
      </div>

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
