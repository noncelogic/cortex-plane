"use client"

import Link from "next/link"
import { useState } from "react"

import type { AgentSummary } from "@/lib/api-client"
import { relativeTime } from "@/lib/format"

import { AgentStatusBadge } from "./agent-status-badge"

/** Minimal resource metrics attached via SSE or API extension. */
export interface AgentMetrics {
  cpuPercent: number
  memPercent: number
  /** Recent CPU samples (0-100) for sparkline, oldest first. */
  cpuHistory?: number[]
  lastHeartbeat?: string
  currentTask?: string
}

interface AgentCardProps {
  agent: AgentSummary
  metrics?: AgentMetrics
}

function getInitials(name: string): string {
  return name
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
}

function iconBgForState(state: string, hasError: boolean): string {
  if (hasError) return "bg-red-500/10 text-red-500"
  if (state === "READY") return "bg-emerald-500/10 text-emerald-500"
  if (state === "EXECUTING") return "bg-primary/10 text-primary"
  if (state === "DRAINING") return "bg-orange-500/10 text-orange-500"
  return "bg-secondary text-text-muted"
}

/** Tiny bar-chart sparkline using CSS. */
function Sparkline({ samples }: { samples: number[] }): React.JSX.Element {
  const bars = samples.length > 0 ? samples.slice(-7) : [0, 0, 0, 0, 0, 0, 0]
  return (
    <div className="flex h-8 w-full items-end gap-1 overflow-hidden rounded bg-gradient-to-r from-primary/10 to-primary/[0.02] px-1">
      {bars.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-sm bg-primary/40"
          style={{ height: `${Math.max(v, 4)}%` }}
        />
      ))}
    </div>
  )
}

/** Resource bar (CPU or MEM). */
function ResourceBar({ label, percent }: { label: string; percent: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase text-text-muted">{label}</span>
        <span className="text-[10px] font-bold text-text-main">{percent}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

export function AgentCard({ agent, metrics }: AgentCardProps): React.JSX.Element {
  const [actionsOpen, setActionsOpen] = useState(false)
  const hasError = agent.lifecycleState === "TERMINATED" && !!agent.currentJobId

  return (
    <div className="rounded-xl border border-surface-border bg-surface-light p-4 shadow-sm">
      {/* Header: icon, name, badge */}
      <div className="mb-3 flex items-start justify-between">
        <div className="flex gap-3">
          <div
            className={`flex size-10 items-center justify-center rounded-lg text-lg font-bold ${iconBgForState(agent.lifecycleState, hasError)}`}
          >
            {getInitials(agent.name)}
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-text-main">{agent.name}</h3>
            <p className="truncate font-mono text-xs tracking-tight text-text-muted">
              ID: {agent.id.slice(0, 8)}
            </p>
          </div>
        </div>
        <AgentStatusBadge state={agent.lifecycleState} hasError={hasError} />
      </div>

      {/* Sparkline */}
      <div className="mb-3">
        {metrics?.cpuHistory && metrics.cpuHistory.length > 0 ? (
          <Sparkline samples={metrics.cpuHistory} />
        ) : (
          <div className="flex h-8 w-full items-center justify-center rounded bg-secondary">
            <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
              No recent telemetry
            </span>
          </div>
        )}
      </div>

      {/* Resource bars */}
      {metrics && (
        <div className="mb-3 grid grid-cols-2 gap-3">
          <ResourceBar label="CPU" percent={metrics.cpuPercent} />
          <ResourceBar label="MEM" percent={metrics.memPercent} />
        </div>
      )}

      {/* Current task */}
      {metrics?.currentTask && (
        <p className="mb-3 truncate text-sm italic text-text-muted">{metrics.currentTask}</p>
      )}

      {/* Footer: heartbeat + actions */}
      <div className="flex items-center justify-between border-t border-surface-border pt-3">
        <span className="text-[10px] font-medium text-text-muted">
          {metrics?.lastHeartbeat ? relativeTime(metrics.lastHeartbeat) : agent.role}
        </span>

        {/* Desktop: inline action buttons */}
        <div className="hidden gap-1.5 sm:flex">
          <Link
            href={`/agents/${agent.id}`}
            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-secondary hover:text-primary"
            title="Open"
          >
            <span className="material-symbols-outlined text-lg leading-none">launch</span>
          </Link>
          <Link
            href={`/agents/${agent.id}`}
            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-secondary hover:text-primary"
            title="Stream"
          >
            <span className="material-symbols-outlined text-lg leading-none">terminal</span>
          </Link>
          <Link
            href={`/agents/${agent.id}`}
            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-secondary hover:text-primary"
            title="Observe"
          >
            <span className="material-symbols-outlined text-lg leading-none">monitoring</span>
          </Link>
        </div>

        {/* Mobile: overflow menu */}
        <div className="relative sm:hidden">
          <button
            onClick={() => setActionsOpen(!actionsOpen)}
            className="flex items-center gap-1 text-sm font-bold text-primary"
          >
            Quick Actions
            <span className="material-symbols-outlined text-sm">
              {actionsOpen ? "expand_less" : "expand_more"}
            </span>
          </button>

          {actionsOpen && (
            <div className="absolute bottom-full right-0 z-10 mb-2 w-48 rounded-xl border border-surface-border bg-surface-light p-2 shadow-lg">
              <Link
                href={`/agents/${agent.id}`}
                className="flex items-center gap-3 rounded-lg p-3 transition-colors hover:bg-primary/5"
              >
                <span className="material-symbols-outlined text-primary">launch</span>
                <div className="text-left">
                  <span className="block text-sm font-bold">Open</span>
                  <span className="text-xs text-text-muted">View details</span>
                </div>
              </Link>
              <Link
                href={`/agents/${agent.id}`}
                className="flex items-center gap-3 rounded-lg p-3 transition-colors hover:bg-primary/5"
              >
                <span className="material-symbols-outlined text-emerald-500">stream</span>
                <div className="text-left">
                  <span className="block text-sm font-bold">Stream</span>
                  <span className="text-xs text-text-muted">Live logs</span>
                </div>
              </Link>
              <Link
                href={`/agents/${agent.id}`}
                className="flex items-center gap-3 rounded-lg p-3 transition-colors hover:bg-primary/5"
              >
                <span className="material-symbols-outlined text-amber-500">monitoring</span>
                <div className="text-left">
                  <span className="block text-sm font-bold">Observe</span>
                  <span className="text-xs text-text-muted">Metrics</span>
                </div>
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
