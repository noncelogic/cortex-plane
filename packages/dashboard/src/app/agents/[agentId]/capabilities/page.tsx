"use client"

import Link from "next/link"
import { use, useCallback, useState } from "react"

import { CapabilityAuditTable } from "@/components/capability-audit-table"
import { BulkBindForm, ToolBindingForm } from "@/components/tool-binding-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useApiQuery } from "@/hooks/use-api"
import type { ToolApprovalPolicy, ToolBinding } from "@/lib/api/tool-bindings"
import {
  bulkBindTools,
  createToolBinding,
  deleteToolBinding,
  getCapabilityAudit,
  getEffectiveTools,
  getMcpServer,
  listMcpServers,
  listToolBindings,
} from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function policyVariant(policy: ToolApprovalPolicy): "success" | "warning" | "info" {
  if (policy === "auto") return "success"
  if (policy === "always_approve") return "warning"
  return "info"
}

function policyLabel(policy: ToolApprovalPolicy): string {
  if (policy === "auto") return "Auto"
  if (policy === "always_approve") return "Always Approve"
  return "Conditional"
}

function rateLimitDisplay(rl: Record<string, unknown> | null): string {
  if (!rl) return "—"
  const maxRaw = rl.maxCalls ?? rl.max_calls
  const winRaw = rl.windowSeconds ?? rl.window_seconds
  if (maxRaw != null && winRaw != null) {
    const max = Number(maxRaw)
    const win = Number(winRaw)
    if (win >= 3600) return `${max}/hr`
    return `${max}/${win}s`
  }
  return JSON.stringify(rl)
}

// ---------------------------------------------------------------------------
// Delete confirmation dialog
// ---------------------------------------------------------------------------

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 max-w-sm rounded-xl border border-surface-border bg-surface-light p-5">
        <p className="mb-4 text-sm text-text-main">{message}</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" onClick={onConfirm}>
            Remove
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

interface CapabilitiesPageProps {
  params: Promise<{ agentId: string }>
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function AgentCapabilitiesPage({
  params,
}: CapabilitiesPageProps): React.JSX.Element {
  const { agentId } = use(params)

  // ---- Data fetching ----
  const { data: bindingsData, refetch: refetchBindings } = useApiQuery(
    () => listToolBindings(agentId),
    [agentId],
  )

  const { data: effectiveData, refetch: refetchEffective } = useApiQuery(
    () => getEffectiveTools(agentId),
    [agentId],
  )

  const { data: serversData } = useApiQuery(() => listMcpServers(), [])

  // ---- Audit state ----
  const [auditFilters, setAuditFilters] = useState<{
    toolRef?: string
    eventType?: string
  }>({})
  const [auditOffset, setAuditOffset] = useState(0)
  const AUDIT_LIMIT = 20

  const { data: auditData, loading: auditLoading } = useApiQuery(
    () =>
      getCapabilityAudit(agentId, {
        ...auditFilters,
        limit: AUDIT_LIMIT,
        offset: auditOffset,
      }),
    [agentId, auditFilters, auditOffset],
  )

  // ---- Category filter ----
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)

  // ---- Delete dialog ----
  const [deleteTarget, setDeleteTarget] = useState<ToolBinding | null>(null)

  // ---- Mutations ----
  const refreshAll = useCallback(() => {
    void refetchBindings()
    void refetchEffective()
  }, [refetchBindings, refetchEffective])

  const handleCreateBinding = useCallback(
    async (data: {
      toolRef: string
      approvalPolicy: ToolApprovalPolicy
      rateLimit: { maxCalls: number; windowSeconds: number } | null
      dataScope: Record<string, unknown> | null
    }) => {
      await createToolBinding(agentId, {
        toolRef: data.toolRef,
        approvalPolicy: data.approvalPolicy,
        rateLimit: data.rateLimit,
        dataScope: data.dataScope,
      })
      refreshAll()
    },
    [agentId, refreshAll],
  )

  const handleBulkBind = useCallback(
    async (data: {
      mcpServerId: string
      toolRefs: string[]
      approvalPolicy: ToolApprovalPolicy
    }) => {
      await bulkBindTools(agentId, data)
      refreshAll()
    },
    [agentId, refreshAll],
  )

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    await deleteToolBinding(agentId, deleteTarget.id)
    setDeleteTarget(null)
    refreshAll()
  }, [agentId, deleteTarget, refreshAll])

  const loadServerTools = useCallback(async (serverId: string) => {
    const detail = await getMcpServer(serverId)
    return (detail.tools ?? []).map((t) => ({
      qualifiedName: t.qualified_name,
      name: t.name,
    }))
  }, [])

  // ---- Derived state ----
  const bindings = bindingsData?.bindings ?? []
  const effectiveTools = effectiveData?.tools ?? []
  const servers = (serversData?.servers ?? []).map((s) => ({ id: s.id, name: s.name }))

  const filteredEffectiveTools = categoryFilter
    ? effectiveTools.filter((tool) => tool.toolRef.includes(categoryFilter))
    : effectiveTools

  // Extract unique category-like prefixes from tool refs (server slug before ::)
  const categories = [
    ...new Set(
      effectiveTools
        .map((tool) => tool.toolRef.split("::")[0] ?? tool.source.kind)
        .filter((c): c is string => typeof c === "string" && c.length > 0),
    ),
  ]

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/agents" className="text-slate-400 transition-colors hover:text-primary">
          Agents
        </Link>
        <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
        <Link
          href={`/agents/${agentId}`}
          className="text-slate-400 transition-colors hover:text-primary"
        >
          {agentId}
        </Link>
        <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
        <span className="flex items-center gap-1.5 font-bold text-white">
          <span className="material-symbols-outlined text-sm text-primary">build</span>
          Capabilities
        </span>
      </nav>

      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
          <span className="material-symbols-outlined text-lg text-primary">build</span>
        </div>
        <div>
          <h1 className="font-display text-xl font-black tracking-tight text-white lg:text-2xl">
            Capabilities
          </h1>
          <p className="text-xs text-slate-500">
            Manage tool bindings, approval policies, and rate limits
          </p>
        </div>
      </div>

      {/* Category filter chips */}
      {categories.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setCategoryFilter(null)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              categoryFilter === null
                ? "bg-primary text-primary-content"
                : "bg-secondary text-text-muted hover:text-text-main"
            }`}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategoryFilter(cat === categoryFilter ? null : cat)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                categoryFilter === cat
                  ? "bg-primary text-primary-content"
                  : "bg-secondary text-text-muted hover:text-text-main"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Effective Tools Table */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-text-muted">
          <span className="material-symbols-outlined text-sm">checklist</span>
          Effective Tools
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px]">
            {effectiveTools.length}
          </span>
        </h2>

        {filteredEffectiveTools.length === 0 ? (
          <div className="rounded-xl border border-dashed border-surface-border p-8 text-center">
            <span className="material-symbols-outlined mb-2 text-3xl text-text-muted">
              extension
            </span>
            <p className="text-sm text-text-muted">No executable effective tools</p>
            <p className="mt-1 text-xs text-text-muted">
              Bind supported tools below. Disabled or unresolvable bindings are excluded here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-surface-border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-surface-border bg-secondary/30">
                  <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                    Tool
                  </th>
                  <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                    Runtime
                  </th>
                  <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                    Policy
                  </th>
                  <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                    Rate Limit
                  </th>
                  <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                    Source
                  </th>
                  <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredEffectiveTools.map((tool) => (
                  <tr
                    key={tool.bindingId}
                    className="border-b border-surface-border last:border-b-0 hover:bg-secondary/20"
                  >
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs text-text-main">{tool.toolRef}</div>
                      <div className="mt-1 text-xs text-text-muted">{tool.description}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs text-text-main">{tool.runtimeName}</span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={policyVariant(tool.approvalPolicy)}>
                        {policyLabel(tool.approvalPolicy)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-text-muted">
                      {rateLimitDisplay(tool.rateLimit)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="info">{tool.source.kind}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const binding = bindings.find(
                            (candidate) => candidate.id === tool.bindingId,
                          )
                          if (binding) setDeleteTarget(binding)
                        }}
                        title="Remove binding"
                      >
                        <span className="material-symbols-outlined text-sm text-danger">
                          delete
                        </span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Bind Tool + Bulk Bind side by side */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-surface-border p-5">
          <h2 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-text-muted">
            <span className="material-symbols-outlined text-sm">add_circle</span>
            Bind Tool
          </h2>
          <ToolBindingForm onSubmit={handleCreateBinding} />
        </section>

        <section className="rounded-xl border border-surface-border p-5">
          <h2 className="mb-4 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-text-muted">
            <span className="material-symbols-outlined text-sm">playlist_add</span>
            Bulk Bind from MCP Server
          </h2>
          <BulkBindForm servers={servers} onLoadTools={loadServerTools} onSubmit={handleBulkBind} />
        </section>
      </div>

      {/* Audit Log */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-text-muted">
          <span className="material-symbols-outlined text-sm">history</span>
          Audit Log
        </h2>
        <CapabilityAuditTable
          entries={auditData?.entries ?? []}
          total={auditData?.total ?? 0}
          limit={AUDIT_LIMIT}
          offset={auditOffset}
          onPageChange={setAuditOffset}
          onFilterChange={(f) => {
            setAuditFilters(f)
            setAuditOffset(0)
          }}
          loading={auditLoading}
        />
      </section>

      {/* Delete confirmation */}
      {deleteTarget && (
        <ConfirmDialog
          message={`Remove binding for "${deleteTarget.toolRef}"? This cannot be undone.`}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
