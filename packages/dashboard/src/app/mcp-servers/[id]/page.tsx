"use client"

import Link from "next/link"
import { useParams, useRouter } from "next/navigation"
import { useCallback, useState } from "react"

import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { Skeleton } from "@/components/layout/skeleton"
import { McpHealthBadge } from "@/components/mcp/McpHealthBadge"
import { McpServerForm } from "@/components/mcp/McpServerForm"
import { McpToolList } from "@/components/mcp/McpToolList"
import { useApiQuery } from "@/hooks/use-api"
import { deleteMcpServer, getMcpServer, refreshMcpServer } from "@/lib/api-client"

function transportLabel(transport: string): string {
  return transport === "streamable-http" ? "Streamable HTTP" : "stdio"
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "N/A"
  return new Date(iso).toLocaleString()
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${ms / 1000}s`
  if (ms < 3_600_000) return `${ms / 60_000}m`
  return `${ms / 3_600_000}h`
}

export default function McpServerDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [editOpen, setEditOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const {
    data: server,
    isLoading,
    error,
    errorCode,
    refetch,
  } = useApiQuery(() => getMcpServer(params.id), [params.id])

  const handleRefreshTools = useCallback(async () => {
    setRefreshing(true)
    try {
      await refreshMcpServer(params.id)
      await refetch()
    } finally {
      setRefreshing(false)
    }
  }, [params.id, refetch])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteMcpServer(params.id)
      router.push("/mcp-servers")
    } catch {
      setDeleting(false)
      setDeleteConfirm(false)
    }
  }, [params.id, router])

  const handleEditSuccess = useCallback(() => {
    setEditOpen(false)
    void refetch()
  }, [refetch])

  // Loading
  if (isLoading && !server) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-48 w-full" />
          </div>
        </div>
      </div>
    )
  }

  // Error
  if (error) {
    return (
      <div className="space-y-6">
        <Link
          href="/mcp-servers"
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          Back to servers
        </Link>
        <ApiErrorBanner error={error} errorCode={errorCode} onRetry={() => void refetch()} />
      </div>
    )
  }

  if (!server) return <></>

  return (
    <div className="space-y-6">
      {/* Breadcrumb + actions */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/mcp-servers"
            className="flex size-8 items-center justify-center rounded-lg text-text-muted hover:bg-secondary transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          </Link>
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
            <span className="material-symbols-outlined text-[20px] text-primary">dns</span>
          </div>
          <div>
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-text-main dark:text-slate-100">
              {server.name}
            </h1>
            <p className="text-xs text-text-muted">{server.slug}</p>
          </div>
          <McpHealthBadge status={server.status} />
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => void handleRefreshTools()}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary transition-all hover:bg-primary/20 disabled:opacity-50"
          >
            {refreshing ? (
              <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            ) : (
              <span className="material-symbols-outlined text-lg">refresh</span>
            )}
            Refresh Tools
          </button>
          <button
            onClick={() => setEditOpen(true)}
            className="flex items-center gap-2 rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold transition-all hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700"
          >
            <span className="material-symbols-outlined text-lg">edit</span>
            Edit
          </button>
          <button
            onClick={() => setDeleteConfirm(true)}
            className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-500 transition-all hover:bg-red-500/20"
          >
            <span className="material-symbols-outlined text-lg">delete</span>
            Delete
          </button>
        </div>
      </div>

      {/* Content grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left: info + tools */}
        <div className="lg:col-span-2 space-y-6">
          {/* Server info */}
          <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
            <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
              <h2 className="text-sm font-bold text-text-main dark:text-white">
                Server Information
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-4 p-5 sm:grid-cols-3">
              <InfoItem label="Transport" value={transportLabel(server.transport)} />
              <InfoItem
                label="Endpoint"
                value={
                  server.transport === "streamable-http"
                    ? ((server.connection.url as string) ?? "N/A")
                    : ((server.connection.command as string) ?? "N/A")
                }
              />
              <InfoItem
                label="Health Interval"
                value={formatInterval(server.health_probe_interval_ms)}
              />
              <InfoItem label="Protocol Version" value={server.protocol_version ?? "Unknown"} />
              <InfoItem label="Created" value={formatDate(server.created_at)} />
              <InfoItem label="Last Healthy" value={formatDate(server.last_healthy_at)} />
            </div>
            {server.description && (
              <div className="border-t border-slate-100 px-5 py-3 dark:border-slate-800">
                <p className="text-xs text-text-muted">{server.description}</p>
              </div>
            )}
            {server.error_message && (
              <div className="border-t border-red-500/10 bg-red-500/5 px-5 py-3">
                <div className="flex items-start gap-2">
                  <span className="material-symbols-outlined mt-0.5 text-[16px] text-red-500">
                    error
                  </span>
                  <div>
                    <p className="text-xs font-semibold text-red-500">Error</p>
                    <p className="mt-0.5 text-xs text-red-400">{server.error_message}</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Tool catalog */}
          <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
            <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-text-main dark:text-white">Tool Catalog</h2>
                <span className="text-xs font-medium text-text-muted">
                  {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}
                </span>
              </div>
            </div>
            <div className="p-5">
              <McpToolList tools={server.tools} />
            </div>
          </div>
        </div>

        {/* Right: capabilities + agent scope */}
        <div className="space-y-6">
          {/* Capabilities */}
          {server.capabilities && Object.keys(server.capabilities).length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
              <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
                <h2 className="text-sm font-bold text-text-main dark:text-white">Capabilities</h2>
              </div>
              <div className="p-5">
                <div className="flex flex-wrap gap-2">
                  {Object.entries(server.capabilities).map(([key, val]) => (
                    <span
                      key={key}
                      className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                        val
                          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "border-slate-300/20 bg-slate-300/10 text-slate-400"
                      }`}
                    >
                      {key}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Server info (JSON) */}
          {server.server_info && Object.keys(server.server_info).length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
              <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
                <h2 className="text-sm font-bold text-text-main dark:text-white">
                  Server Metadata
                </h2>
              </div>
              <div className="p-5">
                <pre className="overflow-x-auto text-xs text-text-muted leading-relaxed">
                  {JSON.stringify(server.server_info, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {/* Agent scope */}
          <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
            <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
              <h2 className="text-sm font-bold text-text-main dark:text-white">Agent Scope</h2>
            </div>
            <div className="p-5">
              {server.agent_scope.length === 0 ? (
                <p className="text-xs text-text-muted">
                  Available to all agents (no scope restriction).
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {server.agent_scope.map((agentId) => (
                    <span
                      key={agentId}
                      className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] font-bold text-primary"
                    >
                      {agentId}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Edit modal */}
      <McpServerForm
        open={editOpen}
        onClose={() => setEditOpen(false)}
        onSuccess={handleEditSuccess}
        server={server}
      />

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <DeleteConfirmDialog
          serverName={server.name}
          deleting={deleting}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteConfirm(false)}
        />
      )}
    </div>
  )
}

/* ── Sub-components ──────────────────────────────────── */

function InfoItem({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium text-text-main dark:text-white">{value}</p>
    </div>
  )
}

function DeleteConfirmDialog({
  serverName,
  deleting,
  onConfirm,
  onCancel,
}: {
  serverName: string
  deleting: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-sm rounded-xl border border-surface-border bg-surface-light p-6 shadow-2xl dark:bg-surface-dark">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-red-500/10">
            <span className="material-symbols-outlined text-[20px] text-red-500">warning</span>
          </div>
          <div>
            <h3 className="text-sm font-bold text-text-main dark:text-white">Delete server?</h3>
            <p className="mt-1 text-xs text-text-muted">
              This will permanently delete <strong>{serverName}</strong> and all its registered
              tools. This action cannot be undone.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm font-semibold text-text-main transition-colors hover:bg-secondary dark:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="flex items-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-red-600 disabled:opacity-50"
          >
            {deleting && (
              <span className="size-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            )}
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
