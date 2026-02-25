"use client"

import Link from "next/link"

import type { AgentSummary } from "@/lib/api-client"
import { relativeTime } from "@/lib/format"

import type { AgentMetrics } from "./agent-card"
import { AgentStatusBadge } from "./agent-status-badge"

interface AgentTableProps {
  agents: AgentSummary[]
  metricsMap: Record<string, AgentMetrics>
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
  return "bg-slate-200 text-slate-400 dark:bg-slate-800"
}

function ResourceBars({
  cpuPercent,
  memPercent,
  dimmed,
}: {
  cpuPercent: number
  memPercent: number
  dimmed?: boolean
}): React.JSX.Element {
  const wrapperClass = dimmed ? "opacity-40 grayscale" : ""
  return (
    <div className={`flex w-32 flex-col gap-2 ${wrapperClass}`}>
      <div>
        <div className="mb-0.5 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase text-slate-400">CPU</span>
          <span className="text-[10px] font-bold text-slate-900 dark:text-slate-100">
            {cpuPercent}%
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
          <div className="h-full rounded-full bg-primary" style={{ width: `${cpuPercent}%` }} />
        </div>
      </div>
      <div>
        <div className="mb-0.5 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase text-slate-400">MEM</span>
          <span className="text-[10px] font-bold text-slate-900 dark:text-slate-100">
            {memPercent}%
          </span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
          <div className="h-full rounded-full bg-primary" style={{ width: `${memPercent}%` }} />
        </div>
      </div>
    </div>
  )
}

export function AgentTable({ agents, metricsMap }: AgentTableProps): React.JSX.Element {
  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-12 text-center text-slate-500 dark:border-slate-700">
        No agents registered. Deploy a new agent to see it here.
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/20">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-800/50">
            <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Agent Details
            </th>
            <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Status
            </th>
            <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Current Task
            </th>
            <th className="px-6 py-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Resources (CPU/Mem)
            </th>
            <th className="px-6 py-4 text-right text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {agents.map((agent) => {
            const m = metricsMap[agent.id]
            const hasError = agent.lifecycleState === "TERMINATED" && !!agent.currentJobId

            return (
              <tr
                key={agent.id}
                className="group transition-colors hover:bg-primary/5 dark:hover:bg-primary/10"
              >
                {/* Agent Details */}
                <td className="px-6 py-4">
                  <div className="flex items-center gap-4">
                    <div
                      className={`flex size-10 items-center justify-center rounded-lg text-lg font-bold ${iconBgForState(agent.lifecycleState, hasError)}`}
                    >
                      {getInitials(agent.name)}
                    </div>
                    <div>
                      <div className="font-bold text-slate-900 dark:text-slate-100">
                        {agent.name}
                      </div>
                      <div className="font-mono text-xs text-slate-400">
                        ID: {agent.id.slice(0, 12)}
                      </div>
                    </div>
                  </div>
                </td>

                {/* Status */}
                <td className="px-6 py-4">
                  <AgentStatusBadge state={agent.lifecycleState} hasError={hasError} />
                </td>

                {/* Current Task / Heartbeat */}
                <td className="px-6 py-4">
                  {m?.currentTask ? (
                    <>
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {m.currentTask}
                      </div>
                      {m.lastHeartbeat && (
                        <div className="text-xs text-slate-400">
                          {relativeTime(m.lastHeartbeat)}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-sm text-slate-400">
                      {agent.currentJobId ? `Job: ${agent.currentJobId.slice(0, 8)}` : "Idle"}
                    </div>
                  )}
                </td>

                {/* Resources */}
                <td className="px-6 py-4">
                  {m ? (
                    <ResourceBars
                      cpuPercent={m.cpuPercent}
                      memPercent={m.memPercent}
                      dimmed={hasError}
                    />
                  ) : (
                    <div className="w-32 opacity-40">
                      <div className="h-1 w-full rounded-full bg-slate-200 dark:bg-slate-700" />
                      <div className="mt-2 h-1 w-full rounded-full bg-slate-200 dark:bg-slate-700" />
                    </div>
                  )}
                </td>

                {/* Actions */}
                <td className="px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                    {hasError && (
                      <Link
                        href={`/agents/${agent.id}`}
                        className="rounded-lg border border-red-500/20 bg-red-500/10 p-2 text-red-500 transition-all hover:bg-red-500 hover:text-white"
                        title="Restart"
                      >
                        <span className="material-symbols-outlined text-xl leading-none">
                          refresh
                        </span>
                      </Link>
                    )}
                    <Link
                      href={`/agents/${agent.id}`}
                      className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-200 hover:text-primary dark:hover:bg-slate-700"
                      title="Logs"
                    >
                      <span className="material-symbols-outlined text-xl leading-none">
                        article
                      </span>
                    </Link>
                    <Link
                      href={`/agents/${agent.id}`}
                      className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-200 hover:text-primary dark:hover:bg-slate-700"
                      title="Terminal"
                    >
                      <span className="material-symbols-outlined text-xl leading-none">
                        terminal
                      </span>
                    </Link>
                    <Link
                      href={`/agents/${agent.id}`}
                      className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-200 hover:text-primary dark:hover:bg-slate-700"
                      title="More"
                    >
                      <span className="material-symbols-outlined text-xl leading-none">
                        more_vert
                      </span>
                    </Link>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
