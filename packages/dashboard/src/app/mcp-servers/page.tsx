"use client"

import { useCallback, useMemo, useState } from "react"

import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { Skeleton } from "@/components/layout/skeleton"
import { McpHealthBadge } from "@/components/mcp/McpHealthBadge"
import { McpServerCard } from "@/components/mcp/McpServerCard"
import { McpServerForm } from "@/components/mcp/McpServerForm"
import { useApiQuery } from "@/hooks/use-api"
import type { McpServer, McpServerStatus } from "@/lib/api-client"
import { listMcpServers } from "@/lib/api-client"

const STATUS_FILTERS: { label: string; value: McpServerStatus | "ALL" }[] = [
  { label: "All Statuses", value: "ALL" },
  { label: "Active", value: "ACTIVE" },
  { label: "Pending", value: "PENDING" },
  { label: "Degraded", value: "DEGRADED" },
  { label: "Error", value: "ERROR" },
  { label: "Disabled", value: "DISABLED" },
]

export default function McpServersPage(): React.JSX.Element {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<McpServerStatus | "ALL">("ALL")
  const [registerOpen, setRegisterOpen] = useState(false)

  const { data, isLoading, error, errorCode, refetch } = useApiQuery(
    () => listMcpServers({ limit: 100 }),
    [],
  )

  const servers: McpServer[] = data?.servers ?? []

  const filtered = useMemo(() => {
    return servers.filter((s) => {
      if (statusFilter !== "ALL" && s.status !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          s.name.toLowerCase().includes(q) ||
          s.slug.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [servers, search, statusFilter])

  const activeCount = servers.filter((s) => s.status === "ACTIVE").length

  const handleRefresh = useCallback(() => {
    void refetch()
  }, [refetch])

  const handleRegisterSuccess = useCallback(() => {
    setRegisterOpen(false)
    void refetch()
  }, [refetch])

  // Loading skeleton
  if (isLoading && servers.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-[28px] text-primary">dns</span>
          <h1 className="font-display text-2xl font-bold tracking-tight text-text-main dark:text-white">
            MCP Servers
          </h1>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900/40"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
              <Skeleton className="h-8 w-full" />
              <div className="grid grid-cols-2 gap-3">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-text-main dark:text-slate-100">
            MCP Servers
          </h1>
          <p className="max-w-lg text-slate-500 dark:text-slate-400">
            Register, monitor, and manage Model Context Protocol servers.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => setRegisterOpen(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90"
          >
            <span className="material-symbols-outlined text-lg">add</span>
            Register Server
          </button>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/40">
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-slate-400">
              search
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search servers..."
              className="rounded-lg border-none bg-slate-100 py-2 pl-10 pr-4 text-sm outline-none transition-all focus:ring-2 focus:ring-primary/50 dark:bg-slate-800"
            />
          </div>

          {/* Status Filter */}
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-slate-400">
              filter_alt
            </span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as McpServerStatus | "ALL")}
              className="cursor-pointer appearance-none rounded-lg border-none bg-slate-100 py-2 pl-10 pr-8 text-sm focus:ring-2 focus:ring-primary/50 dark:bg-slate-800"
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Active count */}
          <McpHealthBadge status="ACTIVE" />
          <span className="text-xs font-bold text-slate-500">{activeCount} active</span>

          {/* Refresh */}
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-all hover:bg-primary/20 disabled:opacity-50"
          >
            <span
              className={`material-symbols-outlined text-lg ${isLoading ? "animate-spin" : ""}`}
            >
              {isLoading ? "progress_activity" : "refresh"}
            </span>
            {isLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && <ApiErrorBanner error={error} errorCode={errorCode} onRetry={handleRefresh} />}

      {/* Empty state */}
      {!isLoading && !error && servers.length === 0 ? (
        <EmptyState
          icon="dns"
          title="No MCP servers registered"
          description="Register your first MCP server to connect tools and capabilities to your agents."
          actionLabel="Register Server"
          onAction={() => setRegisterOpen(true)}
        />
      ) : (
        <>
          {/* Count */}
          <div className="text-sm font-medium text-slate-500 dark:text-slate-400">
            Showing{" "}
            <span className="font-bold text-slate-900 dark:text-slate-100">{filtered.length}</span>{" "}
            of{" "}
            <span className="font-bold text-slate-900 dark:text-slate-100">{servers.length}</span>{" "}
            servers
          </div>

          {/* Server grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((server) => (
              <McpServerCard key={server.id} server={server} />
            ))}
          </div>
        </>
      )}

      <McpServerForm
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        onSuccess={handleRegisterSuccess}
      />
    </div>
  )
}
