"use client"

import { use, useMemo } from "react"

import { ActivityStream } from "@/components/activity-stream"
import { AgentControlPanel } from "@/components/agent-control-panel"
import { CostSummary } from "@/components/cost-summary"
import { PageHeader } from "@/components/layout/page-header"
import { Skeleton } from "@/components/layout/skeleton"
import { useActivityStream } from "@/hooks/use-activity-stream"
import { useApiQuery } from "@/hooks/use-api"
import { type AgentEvent, getAgent, getAgentCost, getAgentEvents } from "@/lib/api-client"
import { relativeTime } from "@/lib/format"

// ---------------------------------------------------------------------------
// State → color mapping (per acceptance criteria)
// ---------------------------------------------------------------------------

const STATE_COLORS: Record<string, { bg: string; text: string }> = {
  EXECUTING: { bg: "bg-emerald-500/10", text: "text-emerald-500" },
  DEGRADED: { bg: "bg-amber-500/10", text: "text-amber-500" },
  QUARANTINED: { bg: "bg-red-500/10", text: "text-red-500" },
  READY: { bg: "bg-blue-500/10", text: "text-blue-500" },
  BOOTING: { bg: "bg-blue-500/10", text: "text-blue-400" },
  HYDRATING: { bg: "bg-blue-500/10", text: "text-blue-400" },
  DRAINING: { bg: "bg-orange-500/10", text: "text-orange-500" },
  TERMINATED: { bg: "bg-slate-500/10", text: "text-slate-400" },
}

function stateStyle(state: string | undefined) {
  return STATE_COLORS[state ?? "READY"] ?? { bg: "bg-slate-500/10", text: "text-slate-400" }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface Props {
  params: Promise<{ agentId: string }>
}

export default function AgentOperationsPage({ params }: Props): React.JSX.Element {
  const { agentId } = use(params)

  // Agent detail
  const {
    data: agent,
    isLoading: agentLoading,
    refetch,
  } = useApiQuery(() => getAgent(agentId), [agentId])

  // Cost (24h)
  const since24h = useMemo(() => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), [])
  const { data: costData, isLoading: costLoading } = useApiQuery(
    () => getAgentCost(agentId, { since: since24h, groupBy: "model" }),
    [agentId],
  )

  // Recent events (paginated)
  const { data: eventData } = useApiQuery(() => getAgentEvents(agentId, { limit: 100 }), [agentId])

  // Live SSE stream for this agent
  const { events: liveEvents, connected } = useActivityStream({
    agentIds: agentId,
  })

  // Merge REST events + live SSE events for display
  const activityEvents = useMemo(() => {
    // Convert REST events to ActivityEvent format
    const restEvents = (eventData?.events ?? []).map((e: AgentEvent) => ({
      agentId: e.agentId,
      timestamp: e.createdAt,
      eventType: e.eventType,
      payload: { ...e.payload, costUsd: e.costUsd, toolRef: e.toolRef },
    }))
    // Dedupe by checking if live events have timestamps already in rest events
    const restTimestamps = new Set(restEvents.map((e) => e.timestamp))
    const uniqueLive = liveEvents.filter((e) => !restTimestamps.has(e.timestamp))
    return [...restEvents, ...uniqueLive]
  }, [eventData, liveEvents])

  const lifecycleState = agent?.lifecycle_state ?? "READY"
  const style = stateStyle(lifecycleState)

  if (agentLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-48 rounded" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <PageHeader title={agent?.name ?? "Agent"} backHref="/operations" />

      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-4">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase ${style.bg} ${style.text}`}
        >
          <span className={`size-2 rounded-full ${style.text.replace("text-", "bg-")}`} />
          {lifecycleState}
        </span>
        {agent?.current_job_id && (
          <span className="text-xs text-text-muted">
            Job: <span className="font-mono">{agent.current_job_id.slice(0, 8)}</span>
          </span>
        )}
        <span className="text-xs text-text-muted">
          Updated {agent?.updated_at ? relativeTime(agent.updated_at) : "—"}
        </span>
      </div>

      {/* Main layout */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Left: Activity + Events */}
        <div className="flex flex-col gap-6">
          <ActivityStream events={activityEvents} connected={connected} showAgent={false} />

          {/* Recent Jobs table */}
          {eventData && eventData.total > 0 && (
            <div className="rounded-xl border border-surface-border bg-surface-light p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="material-symbols-outlined text-lg text-primary">receipt_long</span>
                <h3 className="text-sm font-bold text-text-main">Event Summary</h3>
                <span className="ml-auto text-xs text-text-muted">
                  {eventData.total} total events
                </span>
              </div>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-[10px] font-bold uppercase text-text-muted">Cost</p>
                  <p className="text-sm font-bold text-text-main">
                    ${eventData.costSummary.totalUsd.toFixed(4)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase text-text-muted">Tokens In</p>
                  <p className="text-sm font-bold text-text-main">
                    {eventData.costSummary.tokensIn.toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-bold uppercase text-text-muted">Tokens Out</p>
                  <p className="text-sm font-bold text-text-main">
                    {eventData.costSummary.tokensOut.toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar: Cost + Control */}
        <div className="flex flex-col gap-6">
          <CostSummary data={costData ?? null} isLoading={costLoading} title="Cost (24h)" />
          <AgentControlPanel
            agentId={agentId}
            agentStatus={agent?.status ?? "ACTIVE"}
            onRefresh={() => void refetch()}
          />
        </div>
      </div>
    </div>
  )
}
