"use client"

import { useCallback, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ToolApprovalPolicy } from "@/lib/api/tool-bindings"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APPROVAL_OPTIONS: { value: ToolApprovalPolicy; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "always_approve", label: "Always Approve" },
  { value: "conditional", label: "Conditional" },
]

// ---------------------------------------------------------------------------
// ToolBindingForm — single tool bind
// ---------------------------------------------------------------------------

interface ToolBindingFormProps {
  onSubmit: (data: {
    toolRef: string
    approvalPolicy: ToolApprovalPolicy
    rateLimit: { maxCalls: number; windowSeconds: number } | null
    dataScope: Record<string, unknown> | null
  }) => Promise<void>
  disabled?: boolean
}

export function ToolBindingForm({ onSubmit, disabled }: ToolBindingFormProps): React.JSX.Element {
  const [toolRef, setToolRef] = useState("")
  const [approvalPolicy, setApprovalPolicy] = useState<ToolApprovalPolicy>("auto")
  const [maxCalls, setMaxCalls] = useState("")
  const [windowSeconds, setWindowSeconds] = useState("")
  const [dataScopeJson, setDataScopeJson] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)

      if (!toolRef.trim()) {
        setError("Tool reference is required")
        return
      }

      let dataScope: Record<string, unknown> | null = null
      if (dataScopeJson.trim()) {
        try {
          dataScope = JSON.parse(dataScopeJson) as Record<string, unknown>
        } catch {
          setError("Invalid JSON for data scope")
          return
        }
      }

      const rateLimit =
        maxCalls && windowSeconds
          ? { maxCalls: Number(maxCalls), windowSeconds: Number(windowSeconds) }
          : null

      setSubmitting(true)
      try {
        await onSubmit({ toolRef: toolRef.trim(), approvalPolicy, rateLimit, dataScope })
        setToolRef("")
        setApprovalPolicy("auto")
        setMaxCalls("")
        setWindowSeconds("")
        setDataScopeJson("")
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create binding")
      } finally {
        setSubmitting(false)
      }
    },
    [toolRef, approvalPolicy, maxCalls, windowSeconds, dataScopeJson, onSubmit],
  )

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-text-muted">Tool Reference</label>
        <Input
          icon="build"
          placeholder="e.g. mcp-server-slug::tool_name"
          value={toolRef}
          onChange={(e) => setToolRef(e.target.value)}
          disabled={disabled || submitting}
        />
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-text-muted">Approval Policy</label>
        <select
          value={approvalPolicy}
          onChange={(e) => setApprovalPolicy(e.target.value as ToolApprovalPolicy)}
          disabled={disabled || submitting}
          className="w-full rounded-lg border border-surface-border bg-surface-light px-3 py-2 text-sm text-text-main focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {APPROVAL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-text-muted">
            Max Calls (rate limit)
          </label>
          <Input
            type="number"
            min="1"
            placeholder="e.g. 100"
            value={maxCalls}
            onChange={(e) => setMaxCalls(e.target.value)}
            disabled={disabled || submitting}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text-muted">Window (seconds)</label>
          <Input
            type="number"
            min="1"
            placeholder="e.g. 3600"
            value={windowSeconds}
            onChange={(e) => setWindowSeconds(e.target.value)}
            disabled={disabled || submitting}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-text-muted">
          Data Scope (JSON, optional)
        </label>
        <textarea
          value={dataScopeJson}
          onChange={(e) => setDataScopeJson(e.target.value)}
          disabled={disabled || submitting}
          rows={3}
          placeholder='{"allowed_tables": ["users"]}'
          className="w-full rounded-lg border border-surface-border bg-surface-light px-3 py-2 font-mono text-xs text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <Button type="submit" variant="primary" size="sm" disabled={disabled || submitting}>
        <span className="material-symbols-outlined text-sm">add_circle</span>
        {submitting ? "Binding..." : "Bind Tool"}
      </Button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// BulkBindForm — bind multiple tools from an MCP server
// ---------------------------------------------------------------------------

interface McpServerOption {
  id: string
  name: string
}

interface McpToolOption {
  qualifiedName: string
  name: string
}

interface BulkBindFormProps {
  servers: McpServerOption[]
  onLoadTools: (serverId: string) => Promise<McpToolOption[]>
  onSubmit: (data: {
    mcpServerId: string
    toolRefs: string[]
    approvalPolicy: ToolApprovalPolicy
  }) => Promise<void>
  disabled?: boolean
}

export function BulkBindForm({
  servers,
  onLoadTools,
  onSubmit,
  disabled,
}: BulkBindFormProps): React.JSX.Element {
  const [selectedServer, setSelectedServer] = useState("")
  const [tools, setTools] = useState<McpToolOption[]>([])
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set())
  const [approvalPolicy, setApprovalPolicy] = useState<ToolApprovalPolicy>("auto")
  const [loadingTools, setLoadingTools] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleServerChange = useCallback(
    async (serverId: string) => {
      setSelectedServer(serverId)
      setSelectedTools(new Set())
      setTools([])
      setError(null)

      if (!serverId) return

      setLoadingTools(true)
      try {
        const loaded = await onLoadTools(serverId)
        setTools(loaded)
      } catch {
        setError("Failed to load tools for this server")
      } finally {
        setLoadingTools(false)
      }
    },
    [onLoadTools],
  )

  const toggleTool = useCallback((ref: string) => {
    setSelectedTools((prev) => {
      const next = new Set(prev)
      if (next.has(ref)) next.delete(ref)
      else next.add(ref)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelectedTools((prev) => {
      if (prev.size === tools.length) return new Set()
      return new Set(tools.map((t) => t.qualifiedName))
    })
  }, [tools])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)

      if (!selectedServer) {
        setError("Select an MCP server")
        return
      }

      setSubmitting(true)
      try {
        await onSubmit({
          mcpServerId: selectedServer,
          toolRefs: selectedTools.size > 0 ? [...selectedTools] : [],
          approvalPolicy,
        })
        setSelectedServer("")
        setTools([])
        setSelectedTools(new Set())
      } catch (err) {
        setError(err instanceof Error ? err.message : "Bulk bind failed")
      } finally {
        setSubmitting(false)
      }
    },
    [selectedServer, selectedTools, approvalPolicy, onSubmit],
  )

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-text-muted">MCP Server</label>
        <select
          value={selectedServer}
          onChange={(e) => void handleServerChange(e.target.value)}
          disabled={disabled || submitting}
          className="w-full rounded-lg border border-surface-border bg-surface-light px-3 py-2 text-sm text-text-main focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="">Select a server...</option>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {loadingTools && <p className="text-xs text-text-muted">Loading tools...</p>}

      {tools.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-medium text-text-muted">
              Tools ({selectedTools.size}/{tools.length} selected)
            </label>
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-primary hover:underline"
            >
              {selectedTools.size === tools.length ? "Deselect all" : "Select all"}
            </button>
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-surface-border p-2">
            {tools.map((t) => (
              <label
                key={t.qualifiedName}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-text-main hover:bg-secondary/50"
              >
                <input
                  type="checkbox"
                  checked={selectedTools.has(t.qualifiedName)}
                  onChange={() => toggleTool(t.qualifiedName)}
                  className="accent-primary"
                />
                <span className="font-mono text-xs">{t.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-text-muted">
          Shared Approval Policy
        </label>
        <select
          value={approvalPolicy}
          onChange={(e) => setApprovalPolicy(e.target.value as ToolApprovalPolicy)}
          disabled={disabled || submitting}
          className="w-full rounded-lg border border-surface-border bg-surface-light px-3 py-2 text-sm text-text-main focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {APPROVAL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-xs text-danger">{error}</p>}

      <Button type="submit" variant="primary" size="sm" disabled={disabled || submitting}>
        <span className="material-symbols-outlined text-sm">playlist_add</span>
        {submitting ? "Binding..." : "Bulk Bind"}
      </Button>
    </form>
  )
}
