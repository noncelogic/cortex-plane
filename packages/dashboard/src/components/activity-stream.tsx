"use client"

import { useMemo, useState } from "react"

import type { ActivityEvent } from "@/hooks/use-activity-stream"
import { relativeTime } from "@/lib/format"

// ---------------------------------------------------------------------------
// Event type metadata
// ---------------------------------------------------------------------------

const EVENT_ICONS: Record<string, { icon: string; color: string }> = {
  llm_call_start: { icon: "psychology", color: "text-blue-500" },
  llm_call_end: { icon: "psychology", color: "text-blue-500" },
  tool_call_start: { icon: "build", color: "text-amber-500" },
  tool_call_end: { icon: "build", color: "text-amber-500" },
  tool_denied: { icon: "block", color: "text-red-500" },
  tool_rate_limited: { icon: "speed", color: "text-orange-500" },
  state_transition: { icon: "swap_horiz", color: "text-indigo-500" },
  circuit_breaker_trip: { icon: "report_problem", color: "text-red-600" },
  cost_alert: { icon: "attach_money", color: "text-amber-600" },
  steer_injected: { icon: "navigation", color: "text-primary" },
  steer_acknowledged: { icon: "check_circle", color: "text-emerald-500" },
  kill_requested: { icon: "dangerous", color: "text-red-600" },
  checkpoint_created: { icon: "save", color: "text-emerald-500" },
  error: { icon: "error", color: "text-red-500" },
  session_start: { icon: "play_circle", color: "text-emerald-500" },
  session_end: { icon: "stop_circle", color: "text-text-muted" },
  message_received: { icon: "chat", color: "text-blue-400" },
  message_sent: { icon: "send", color: "text-blue-400" },
}

const EVENT_TYPE_OPTIONS = [
  "llm_call_end",
  "tool_call_end",
  "state_transition",
  "circuit_breaker_trip",
  "cost_alert",
  "steer_injected",
  "kill_requested",
  "error",
] as const

function getEventMeta(eventType: string) {
  return EVENT_ICONS[eventType] ?? { icon: "info", color: "text-text-muted" }
}

function formatEventType(eventType: string): string {
  return eventType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ActivityStreamProps {
  events: ActivityEvent[]
  connected: boolean
  /** Show agent ID column (for fleet-wide view). Default: true */
  showAgent?: boolean
  /** Optional map of agentId -> name for display */
  agentNames?: Record<string, string>
}

export function ActivityStream({
  events,
  connected,
  showAgent = true,
  agentNames,
}: ActivityStreamProps): React.JSX.Element {
  const [typeFilter, setTypeFilter] = useState("")
  const [agentFilter, setAgentFilter] = useState<string>("")

  // Derive unique agent IDs for filter dropdown
  const agentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const e of events) ids.add(e.agentId)
    return Array.from(ids)
  }, [events])

  const filtered = useMemo(() => {
    let list = events
    if (typeFilter) {
      list = list.filter((e) => e.eventType === typeFilter)
    }
    if (agentFilter) {
      list = list.filter((e) => e.agentId === agentFilter)
    }
    // Show newest first
    return [...list].reverse()
  }, [events, typeFilter, agentFilter])

  return (
    <div className="flex flex-col rounded-xl border border-surface-border bg-surface-light">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-primary">stream</span>
          <h3 className="text-sm font-bold text-text-main">Activity Stream</h3>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
              connected ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${connected ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`}
            />
            {connected ? "Live" : "Disconnected"}
          </span>
        </div>
        <span className="text-xs text-text-muted">{filtered.length} events</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-border px-4 py-2">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-lg border border-surface-border bg-surface-dark px-2 py-1 text-xs text-text-main"
        >
          <option value="">All event types</option>
          {EVENT_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {formatEventType(t)}
            </option>
          ))}
        </select>
        {showAgent && agentIds.length > 1 && (
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="rounded-lg border border-surface-border bg-surface-dark px-2 py-1 text-xs text-text-main"
          >
            <option value="">All agents</option>
            {agentIds.map((id) => (
              <option key={id} value={id}>
                {agentNames?.[id] ?? id.slice(0, 8)}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Event list */}
      <div className="max-h-[500px] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <span className="material-symbols-outlined mb-2 text-2xl text-text-muted">
              hourglass_empty
            </span>
            <p className="text-sm font-medium text-text-muted">No events yet</p>
            <p className="mt-1 text-xs text-text-muted">
              Events will appear here as agents execute tasks.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-surface-border">
            {filtered.map((event, i) => {
              const meta = getEventMeta(event.eventType)
              return (
                <li
                  key={`${event.timestamp}-${i}`}
                  className="flex items-start gap-3 px-4 py-2.5 hover:bg-secondary/50 transition-colors"
                >
                  <span className={`material-symbols-outlined mt-0.5 text-lg ${meta.color}`}>
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-text-main">
                        {formatEventType(event.eventType)}
                      </span>
                      {showAgent && (
                        <span className="rounded bg-surface-dark px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                          {agentNames?.[event.agentId] ?? event.agentId.slice(0, 8)}
                        </span>
                      )}
                    </div>
                    {typeof event.payload.toolRef === "string" && (
                      <p className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
                        {event.payload.toolRef}
                      </p>
                    )}
                    {typeof event.payload.costUsd === "number" && event.payload.costUsd > 0 && (
                      <span className="text-[10px] text-amber-500">
                        ${event.payload.costUsd.toFixed(4)}
                      </span>
                    )}
                  </div>
                  <span className="whitespace-nowrap text-[10px] text-text-muted">
                    {relativeTime(event.timestamp)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
