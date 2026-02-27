"use client"

import { useCallback, useMemo, useState } from "react"

import type { AgentMetrics } from "@/components/agents/agent-card"
import { AgentGrid } from "@/components/agents/agent-grid"
import { AgentTable } from "@/components/agents/agent-table"
import { DeployAgentModal } from "@/components/agents/deploy-agent-modal"
import { type ViewMode, ViewToggle } from "@/components/agents/view-toggle"
import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { Skeleton } from "@/components/layout/skeleton"
import { useApiQuery } from "@/hooks/use-api"
import { useSSE } from "@/hooks/use-sse"
import type { AgentLifecycleState, AgentSummary } from "@/lib/api-client"
import { listAgents } from "@/lib/api-client"
import { resolveSSEUrl } from "@/lib/sse-client"

// ---------------------------------------------------------------------------
// Status filter options
// ---------------------------------------------------------------------------

const STATUS_FILTERS: { label: string; value: AgentLifecycleState | "ALL" }[] = [
  { label: "All Statuses", value: "ALL" },
  { label: "Ready", value: "READY" },
  { label: "Executing", value: "EXECUTING" },
  { label: "Draining", value: "DRAINING" },
  { label: "Terminated", value: "TERMINATED" },
  { label: "Booting", value: "BOOTING" },
]

// ---------------------------------------------------------------------------
// Parse SSE events into metrics
// ---------------------------------------------------------------------------

function parseAgentStateEvent(
  data: string,
): { agentId: string; partial: Partial<AgentMetrics> } | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    const agentId = parsed.agentId as string | undefined
    if (!agentId) return null
    const partial: Partial<AgentMetrics> = {}
    if (typeof parsed.cpuPercent === "number") partial.cpuPercent = parsed.cpuPercent
    if (typeof parsed.memPercent === "number") partial.memPercent = parsed.memPercent
    if (typeof parsed.timestamp === "string") partial.lastHeartbeat = parsed.timestamp
    if (typeof parsed.currentTask === "string") partial.currentTask = parsed.currentTask
    return { agentId, partial }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AgentsPage(): React.JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>("table")
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<AgentLifecycleState | "ALL">("ALL")
  const [metricsMap, setMetricsMap] = useState<Record<string, AgentMetrics>>({})
  const [deployOpen, setDeployOpen] = useState(false)

  // Fetch agent list
  const { data, isLoading, error, errorCode, refetch } = useApiQuery(
    () => listAgents({ limit: 100 }),
    [],
  )

  // Real-time SSE for fleet-wide state updates.
  // The backend only exposes per-agent streams (/agents/:id/stream), so
  // fleet-wide SSE is not available yet. Disable auto-connect to prevent
  // a 400 loop from "stream" being parsed as a UUID path param.
  const { connected, events: sseEvents } = useSSE({
    url: resolveSSEUrl("/api/agents/stream"),
    eventTypes: ["agent:state"],
    autoConnect: false,
    maxEvents: 50,
  })

  // Merge SSE state events into metrics
  useMemo(() => {
    for (const event of sseEvents) {
      const result = parseAgentStateEvent(event.data)
      if (result) {
        setMetricsMap((prev) => {
          const existing = prev[result.agentId] ?? { cpuPercent: 0, memPercent: 0 }
          return {
            ...prev,
            [result.agentId]: {
              ...existing,
              ...result.partial,
              cpuHistory: [
                ...(existing.cpuHistory ?? []).slice(-6),
                result.partial.cpuPercent ?? existing.cpuPercent,
              ],
            },
          }
        })
      }
    }
  }, [sseEvents])

  const agents: AgentSummary[] = data?.agents ?? []

  // Filter by search + status
  const filtered = useMemo(() => {
    return agents.filter((a) => {
      if (statusFilter !== "ALL" && a.lifecycleState !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return (
          a.name.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          a.role.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [agents, search, statusFilter])

  // Count online agents
  const onlineCount = agents.filter(
    (a) => a.lifecycleState === "READY" || a.lifecycleState === "EXECUTING",
  ).length

  const handleRefresh = useCallback(() => {
    void refetch()
  }, [refetch])

  const handleDeploySuccess = useCallback(() => {
    setDeployOpen(false)
    void refetch()
  }, [refetch])

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(agents, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "agents-export.json"
    a.click()
    URL.revokeObjectURL(url)
  }, [agents])

  // Loading skeleton
  if (isLoading && agents.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-[28px] text-primary">smart_toy</span>
          <h1 className="font-display text-2xl font-bold tracking-tight text-text-main dark:text-white">
            Agents Inventory
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
            Agents Inventory
          </h1>
          <p className="max-w-lg text-slate-500 dark:text-slate-400">
            Manage and monitor autonomous AI workloads across your clusters.
          </p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleExport}
            disabled={agents.length === 0}
            className="flex items-center gap-2 rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold transition-all hover:bg-slate-300 disabled:opacity-50 dark:bg-slate-800 dark:hover:bg-slate-700"
          >
            <span className="material-symbols-outlined text-lg">download</span>
            Export
          </button>
          <button
            onClick={() => setDeployOpen(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90"
          >
            <span className="material-symbols-outlined text-lg">add</span>
            Deploy New Agent
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
              placeholder="Search agents..."
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
              onChange={(e) => setStatusFilter(e.target.value as AgentLifecycleState | "ALL")}
              className="cursor-pointer appearance-none rounded-lg border-none bg-slate-100 py-2 pl-10 pr-8 text-sm focus:ring-2 focus:ring-primary/50 dark:bg-slate-800"
            >
              {STATUS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          {/* Separator + View Toggle (desktop) */}
          <div className="mx-2 hidden h-8 w-px bg-slate-200 dark:bg-slate-700 md:block" />
          <div className="hidden md:block">
            <ViewToggle mode={viewMode} onChange={setViewMode} />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Online count */}
          <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5">
            <div className="size-2 animate-pulse rounded-full bg-emerald-500" />
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-500">
              {onlineCount} Online
            </span>
          </div>

          {/* SSE status */}
          <div
            className={`flex items-center gap-1.5 rounded-full border px-2 py-1 ${
              connected
                ? "border-emerald-500/20 bg-emerald-500/10"
                : "border-slate-500/20 bg-slate-500/10"
            }`}
            title={connected ? "Live updates connected" : "Live updates disconnected"}
          >
            <div
              className={`size-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-slate-500"}`}
            />
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              {connected ? "Live" : "Offline"}
            </span>
          </div>

          {/* Refresh */}
          <button
            onClick={handleRefresh}
            className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-all hover:bg-primary/20"
          >
            <span className="material-symbols-outlined text-lg">refresh</span>
            Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && <ApiErrorBanner error={error} errorCode={errorCode} onRetry={handleRefresh} />}

      {/* Empty state */}
      {!isLoading && !error && agents.length === 0 ? (
        <EmptyState
          icon="smart_toy"
          title="No agents configured"
          description="Deploy your first autonomous agent to get started."
          actionLabel="Deploy New Agent"
          onAction={() => setDeployOpen(true)}
        />
      ) : (
        <>
          {/* Count */}
          <div className="text-sm font-medium text-slate-500 dark:text-slate-400">
            Showing{" "}
            <span className="font-bold text-slate-900 dark:text-slate-100">{filtered.length}</span>{" "}
            of <span className="font-bold text-slate-900 dark:text-slate-100">{agents.length}</span>{" "}
            agents
          </div>

          {/* Agent Views */}
          {/* Desktop: table or grid based on toggle */}
          <div className="hidden md:block">
            {viewMode === "table" ? (
              <AgentTable agents={filtered} metricsMap={metricsMap} />
            ) : (
              <AgentGrid agents={filtered} metricsMap={metricsMap} />
            )}
          </div>

          {/* Mobile: always card grid */}
          <div className="md:hidden">
            <AgentGrid agents={filtered} metricsMap={metricsMap} />
          </div>
        </>
      )}

      <DeployAgentModal
        open={deployOpen}
        onClose={() => setDeployOpen(false)}
        onSuccess={handleDeploySuccess}
      />
    </div>
  )
}
