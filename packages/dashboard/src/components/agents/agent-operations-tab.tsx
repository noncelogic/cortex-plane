"use client"

import { useEffect, useMemo, useRef } from "react"

import { ActivityStream } from "@/components/activity-stream"
import { AgentControlPanel } from "@/components/agent-control-panel"
import { CostSummary } from "@/components/cost-summary"
import { useToast } from "@/components/layout/toast"
import { useActivityStream } from "@/hooks/use-activity-stream"
import { useApiQuery } from "@/hooks/use-api"
import { useApprovalStream } from "@/hooks/use-approval-stream"
import { type AgentEvent, getAgentCost, getAgentEvents } from "@/lib/api-client"

interface AgentOperationsTabProps {
  agentId: string
  agentStatus: string
  onRefresh: () => void
}

export function AgentOperationsTab({
  agentId,
  agentStatus,
  onRefresh,
}: AgentOperationsTabProps): React.JSX.Element {
  const { addToast } = useToast()

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

  // Approval SSE stream
  const { events: approvalEvents } = useApprovalStream()

  // Auto-refresh when new activity events arrive
  const prevActivityCount = useRef(0)
  useEffect(() => {
    if (liveEvents.length > prevActivityCount.current) {
      prevActivityCount.current = liveEvents.length
      onRefresh()
    }
  }, [liveEvents.length, onRefresh])

  // Toast for approval events related to this agent
  const prevApprovalCount = useRef(0)
  useEffect(() => {
    if (approvalEvents.length > prevApprovalCount.current) {
      const newEvents = approvalEvents.slice(prevApprovalCount.current)
      prevApprovalCount.current = approvalEvents.length
      for (const evt of newEvents) {
        if (evt.type === "created" && evt.data.agent_id === agentId) {
          addToast(`Approval required: ${evt.data.action_summary}`, "warning")
        } else if (evt.type === "decided" && evt.data.job_id) {
          addToast(`Approval ${evt.data.decision.toLowerCase()}`, "info")
        }
      }
      onRefresh()
    }
  }, [approvalEvents.length, approvalEvents, agentId, addToast, onRefresh])

  // Merge REST events + live SSE events for display
  const activityEvents = useMemo(() => {
    const restEvents = (eventData?.events ?? []).map((e: AgentEvent) => ({
      agentId: e.agentId,
      timestamp: e.createdAt,
      eventType: e.eventType,
      payload: { ...e.payload, costUsd: e.costUsd, toolRef: e.toolRef },
    }))
    const restTimestamps = new Set(restEvents.map((e) => e.timestamp))
    const uniqueLive = liveEvents.filter((e) => !restTimestamps.has(e.timestamp))
    return [...restEvents, ...uniqueLive]
  }, [eventData, liveEvents])

  return (
    <div className="flex flex-col gap-6">
      {/* Main layout */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Left: Activity + Events */}
        <div className="flex flex-col gap-6">
          <ActivityStream events={activityEvents} connected={connected} showAgent={false} />

          {/* Event Summary */}
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
          <AgentControlPanel agentId={agentId} agentStatus={agentStatus} onRefresh={onRefresh} />
        </div>
      </div>
    </div>
  )
}
