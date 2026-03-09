"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { useToast } from "@/components/layout/toast"
import type { CreateMcpServerRequest, McpServer, McpTransport } from "@/lib/api-client"
import { createMcpServer, updateMcpServer } from "@/lib/api-client"

interface McpServerFormProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
  /** When set, form acts as "edit" mode pre-populated with server data. */
  server?: McpServer
}

interface FormState {
  name: string
  slug: string
  transport: McpTransport
  description: string
  url: string
  headers: Array<{ key: string; value: string }>
  command: string
  image: string
  envVars: Array<{ key: string; value: string }>
  healthProbeIntervalMs: number
}

function initialState(server?: McpServer): FormState {
  if (server) {
    const conn = server.connection
    return {
      name: server.name,
      slug: server.slug,
      transport: server.transport,
      description: server.description ?? "",
      url: (conn.url as string) ?? "",
      headers: Array.isArray(conn.headers)
        ? (conn.headers as Array<{ key: string; value: string }>)
        : Object.entries((conn.headers as Record<string, string>) ?? {}).map(([key, value]) => ({
            key,
            value,
          })),
      command: (conn.command as string) ?? "",
      image: (conn.image as string) ?? "",
      envVars: Array.isArray(conn.env)
        ? (conn.env as Array<{ key: string; value: string }>)
        : Object.entries((conn.env as Record<string, string>) ?? {}).map(([key, value]) => ({
            key,
            value,
          })),
      healthProbeIntervalMs: server.health_probe_interval_ms,
    }
  }
  return {
    name: "",
    slug: "",
    transport: "streamable-http",
    description: "",
    url: "",
    headers: [],
    command: "",
    image: "",
    envVars: [],
    healthProbeIntervalMs: 30000,
  }
}

export function McpServerForm({
  open,
  onClose,
  onSuccess,
  server,
}: McpServerFormProps): React.JSX.Element | null {
  const { addToast } = useToast()
  const [form, setForm] = useState<FormState>(() => initialState(server))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const isEdit = !!server

  // Reset form when server prop changes
  useEffect(() => {
    setForm(initialState(server))
    setError(null)
  }, [server])

  // Open/close dialog
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  const updateField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }, [])

  const addKvPair = useCallback((field: "headers" | "envVars") => {
    setForm((prev) => ({ ...prev, [field]: [...prev[field], { key: "", value: "" }] }))
  }, [])

  const removeKvPair = useCallback((field: "headers" | "envVars", index: number) => {
    setForm((prev) => ({
      ...prev,
      [field]: prev[field].filter((_, i) => i !== index),
    }))
  }, [])

  const updateKvPair = useCallback(
    (field: "headers" | "envVars", index: number, key: string, value: string) => {
      setForm((prev) => ({
        ...prev,
        [field]: prev[field].map((pair, i) => (i === index ? { key, value } : pair)),
      }))
    },
    [],
  )

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)

      if (!form.name.trim()) {
        setError("Name is required")
        return
      }

      const connection: Record<string, unknown> = {}
      if (form.transport === "streamable-http") {
        if (!form.url.trim()) {
          setError("URL is required for HTTP transport")
          return
        }
        connection.url = form.url.trim()
        const headersObj: Record<string, string> = {}
        for (const h of form.headers) {
          if (h.key.trim()) headersObj[h.key.trim()] = h.value
        }
        if (Object.keys(headersObj).length > 0) connection.headers = headersObj
      } else {
        if (!form.command.trim()) {
          setError("Command is required for stdio transport")
          return
        }
        connection.command = form.command.trim()
        if (form.image.trim()) connection.image = form.image.trim()
        const envObj: Record<string, string> = {}
        for (const v of form.envVars) {
          if (v.key.trim()) envObj[v.key.trim()] = v.value
        }
        if (Object.keys(envObj).length > 0) connection.env = envObj
      }

      const body: CreateMcpServerRequest = {
        name: form.name.trim(),
        transport: form.transport,
        connection,
        description: form.description.trim() || undefined,
        health_probe_interval_ms: form.healthProbeIntervalMs,
      }
      if (form.slug.trim()) body.slug = form.slug.trim()

      setSubmitting(true)
      try {
        if (isEdit && server) {
          await updateMcpServer(server.id, body)
          addToast("MCP server updated", "success")
        } else {
          await createMcpServer(body)
          addToast("MCP server registered", "success")
        }
        onSuccess()
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred")
      } finally {
        setSubmitting(false)
      }
    },
    [form, isEdit, server, onSuccess, addToast],
  )

  if (!open) return null

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="fixed inset-0 z-50 m-auto w-full max-w-lg rounded-xl border border-surface-border bg-surface-light p-0 shadow-2xl backdrop:bg-black/50 dark:bg-surface-dark"
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="font-display text-lg font-bold text-text-main dark:text-white">
            {isEdit ? "Edit MCP Server" : "Register MCP Server"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-lg text-text-muted hover:bg-secondary transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="space-y-4 overflow-y-auto px-6 py-5" style={{ maxHeight: "60vh" }}>
          {/* Name */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-text-muted">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder="My MCP Server"
              className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-slate-800"
            />
          </div>

          {/* Slug (optional) */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-text-muted">
              Slug <span className="font-normal">(optional, auto-generated)</span>
            </label>
            <input
              type="text"
              value={form.slug}
              onChange={(e) => updateField("slug", e.target.value)}
              placeholder="my-mcp-server"
              pattern="^[a-z0-9-]*$"
              className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-slate-800"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-text-muted">
              Description
            </label>
            <textarea
              value={form.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="What does this server provide?"
              rows={2}
              className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-slate-800 resize-none"
            />
          </div>

          {/* Transport selector */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-text-muted">Transport</label>
            <div className="flex gap-2">
              {(["streamable-http", "stdio"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => updateField("transport", t)}
                  className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-all ${
                    form.transport === t
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-surface-border text-text-muted hover:bg-secondary"
                  }`}
                >
                  <span className="material-symbols-outlined mr-1.5 align-middle text-[16px]">
                    {t === "streamable-http" ? "language" : "terminal"}
                  </span>
                  {t === "streamable-http" ? "Streamable HTTP" : "stdio"}
                </button>
              ))}
            </div>
          </div>

          {/* HTTP connection fields */}
          {form.transport === "streamable-http" && (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-text-muted">URL</label>
                <input
                  type="url"
                  value={form.url}
                  onChange={(e) => updateField("url", e.target.value)}
                  placeholder="https://mcp.example.com/sse"
                  className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-slate-800"
                />
              </div>
              <KeyValueEditor
                label="Headers"
                pairs={form.headers}
                keyPlaceholder="Authorization"
                valuePlaceholder="Bearer token..."
                onAdd={() => addKvPair("headers")}
                onRemove={(i) => removeKvPair("headers", i)}
                onUpdate={(i, k, v) => updateKvPair("headers", i, k, v)}
              />
            </>
          )}

          {/* stdio connection fields */}
          {form.transport === "stdio" && (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-text-muted">
                  Command
                </label>
                <input
                  type="text"
                  value={form.command}
                  onChange={(e) => updateField("command", e.target.value)}
                  placeholder="npx -y @example/mcp-server"
                  className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-slate-800"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-text-muted">
                  Image <span className="font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  value={form.image}
                  onChange={(e) => updateField("image", e.target.value)}
                  placeholder="node:20-slim"
                  className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-slate-800"
                />
              </div>
              <KeyValueEditor
                label="Environment Variables"
                pairs={form.envVars}
                keyPlaceholder="API_KEY"
                valuePlaceholder="value..."
                onAdd={() => addKvPair("envVars")}
                onRemove={(i) => removeKvPair("envVars", i)}
                onUpdate={(i, k, v) => updateKvPair("envVars", i, k, v)}
              />
            </>
          )}

          {/* Health probe interval */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-text-muted">
              Health Probe Interval
            </label>
            <select
              value={form.healthProbeIntervalMs}
              onChange={(e) => updateField("healthProbeIntervalMs", Number(e.target.value))}
              className="w-full cursor-pointer rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20 dark:bg-slate-800"
            >
              <option value={10000}>10 seconds</option>
              <option value={30000}>30 seconds</option>
              <option value={60000}>1 minute</option>
              <option value={300000}>5 minutes</option>
              <option value={900000}>15 minutes</option>
              <option value={3600000}>1 hour</option>
            </select>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2">
              <span className="material-symbols-outlined mt-0.5 text-[16px] text-red-500">
                error
              </span>
              <p className="text-xs text-red-500">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-surface-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm font-semibold text-text-main transition-colors hover:bg-secondary dark:text-white"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting && (
              <span className="size-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            )}
            {isEdit ? "Save Changes" : "Register Server"}
          </button>
        </div>
      </form>
    </dialog>
  )
}

/* ── Key-Value pair editor ────────────────────────────── */

function KeyValueEditor({
  label,
  pairs,
  keyPlaceholder,
  valuePlaceholder,
  onAdd,
  onRemove,
  onUpdate,
}: {
  label: string
  pairs: Array<{ key: string; value: string }>
  keyPlaceholder: string
  valuePlaceholder: string
  onAdd: () => void
  onRemove: (index: number) => void
  onUpdate: (index: number, key: string, value: string) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-xs font-semibold text-text-muted">{label}</label>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary/80 transition-colors"
        >
          <span className="material-symbols-outlined text-[14px]">add</span>
          Add
        </button>
      </div>
      {pairs.length > 0 && (
        <div className="space-y-2">
          {pairs.map((pair, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={pair.key}
                onChange={(e) => onUpdate(i, e.target.value, pair.value)}
                placeholder={keyPlaceholder}
                className="flex-1 rounded-lg border border-surface-border bg-surface-dark px-3 py-1.5 text-xs text-text-main outline-none focus:border-primary dark:bg-slate-800"
              />
              <input
                type="text"
                value={pair.value}
                onChange={(e) => onUpdate(i, pair.key, e.target.value)}
                placeholder={valuePlaceholder}
                className="flex-1 rounded-lg border border-surface-border bg-surface-dark px-3 py-1.5 text-xs text-text-main outline-none focus:border-primary dark:bg-slate-800"
              />
              <button
                type="button"
                onClick={() => onRemove(i)}
                className="flex size-7 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-red-500/10 hover:text-red-500 transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
