"use client"

import Link from "next/link"
import { useMemo } from "react"

import { ActivityStream } from "@/components/activity-stream"
import { EmptyState } from "@/components/layout/empty-state"
import { PageHeader } from "@/components/layout/page-header"
import { Skeleton } from "@/components/layout/skeleton"
import { useActivityStream } from "@/hooks/use-activity-stream"
import { useApiQuery } from "@/hooks/use-api"
import type { AgentSummary } from "@/lib/api-client"
import { listAgents } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// State color mapping (per acceptance criteria)
// ---------------------------------------------------------------------------

const STATE_COLORS: Record<string, string> = {
  EXECUTING: "bg-emerald-500",
  DEGRADED: "bg-amber-400",
  QUARANTINED: "bg-red-500",
  READY: "bg-blue-500",
  BOOTING: "bg-blue-400",
  HYDRATING: "bg-blue-400",
  DRAINING: "bg-orange-500",
  TERMINATED: "bg-slate-400",
}

function stateColorClass(state: string | undefined): string {
  return STATE_COLORS[state ?? "READY"] ?? "bg-slate-400"
}

// ---------------------------------------------------------------------------
// Agent overview card
// ---------------------------------------------------------------------------

function AgentOverviewCard({ agent }: { agent: AgentSummary }): React.JSX.Element {
  const state = agent.lifecycle_state ?? "READY"
  return (
    <Link
      href={`/agents/${agent.id}/operations`}
      className="flex items-center gap-3 rounded-xl border border-surface-border bg-surface-light p-4 shadow-sm transition-colors hover:border-primary/30"
    >
      {/* State dot */}
      <span className={`size-3 shrink-0 rounded-full ${stateColorClass(state)}`} />
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-sm font-bold text-text-main">{agent.name}</h4>
        <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{state}</p>
      </div>
      <span className="material-symbols-outlined text-lg text-text-muted">chevron_right</span>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OperationsPage(): React.JSX.Element {
  const { data: agentData, isLoading: agentsLoading } = useApiQuery(() => listAgents(), [])
  const agents = agentData?.agents ?? []

  const { events, connected } = useActivityStream()

  // Build agentId -> name map for activity stream
  const agentNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const a of agents) {
      map[a.id] = a.name
    }
    return map
  }, [agents])

  // Derive fleet stats
  const stats = useMemo(() => {
    let executing = 0
    let ready = 0
    let quarantined = 0
    let other = 0
    for (const a of agents) {
      const s = a.lifecycle_state
      if (s === "EXECUTING") executing++
      else if (s === "READY") ready++
      else if (a.status === "ARCHIVED" || a.status === "DISABLED") quarantined++
      else other++
    }
    return { total: agents.length, executing, ready, quarantined, other }
  }, [agents])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Operations" />

      {/* Fleet stats */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total Agents" value={stats.total} icon="groups" loading={agentsLoading} />
        <StatCard
          label="Executing"
          value={stats.executing}
          icon="play_circle"
          color="text-emerald-500"
          loading={agentsLoading}
        />
        <StatCard
          label="Ready"
          value={stats.ready}
          icon="check_circle"
          color="text-blue-500"
          loading={agentsLoading}
        />
        <StatCard
          label="Quarantined"
          value={stats.quarantined}
          icon="shield"
          color="text-red-500"
          loading={agentsLoading}
        />
      </div>

      {/* Main content: 2-column on desktop */}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* Agent grid */}
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-bold text-text-main">Agent Grid</h3>
          {agentsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 rounded-xl" />
              ))}
            </div>
          ) : agents.length === 0 ? (
            <EmptyState
              icon="smart_toy"
              title="No agents"
              description="Deploy an agent to see it here."
              compact
            />
          ) : (
            <div className="space-y-2">
              {agents.map((a) => (
                <AgentOverviewCard key={a.id} agent={a} />
              ))}
            </div>
          )}
        </div>

        {/* Activity stream */}
        <ActivityStream events={events} connected={connected} showAgent agentNames={agentNames} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  icon,
  color,
  loading,
}: {
  label: string
  value: number
  icon: string
  color?: string
  loading?: boolean
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-light p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className={`material-symbols-outlined text-lg ${color ?? "text-text-muted"}`}>
          {icon}
        </span>
        <span className="text-[10px] font-bold uppercase text-text-muted">{label}</span>
      </div>
      {loading ? (
        <Skeleton className="h-7 w-12 rounded" />
      ) : (
        <p className="text-2xl font-bold text-text-main">{value}</p>
      )}
    </div>
  )
}
