"use client"

import Link from "next/link"

import type { AgentDetail, AgentLifecycleState } from "@/lib/api-client"
import { truncateUuid } from "@/lib/format"

import { AgentStatusBadge } from "./agent-status-badge"

interface AgentHeaderProps {
  agent: AgentDetail
  onPause?: () => void
  onTerminate?: () => void
}

function getInitials(name: string): string {
  return name
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
}

function iconBgForState(state: AgentLifecycleState): string {
  if (state === "READY") return "bg-emerald-500/10 text-emerald-500"
  if (state === "EXECUTING") return "bg-primary/10 text-primary"
  if (state === "DRAINING") return "bg-orange-500/10 text-orange-500"
  return "bg-slate-200 text-slate-400 dark:bg-slate-800"
}

export function AgentHeader({ agent, onPause, onTerminate }: AgentHeaderProps): React.JSX.Element {
  const hasError = agent.lifecycleState === "TERMINATED" && !!agent.currentJobId

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-6 dark:border-primary/10 dark:bg-primary/5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-4">
        {/* Back link (mobile) */}
        <Link
          href="/agents"
          className="flex items-center text-slate-400 transition-colors hover:text-primary lg:hidden"
        >
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        </Link>

        {/* Avatar */}
        <div
          className={`flex size-12 items-center justify-center rounded-lg text-lg font-bold ${iconBgForState(agent.lifecycleState)}`}
        >
          {getInitials(agent.name)}
        </div>

        {/* Name + meta */}
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-black tracking-tight text-slate-900 dark:text-white lg:text-3xl">
              {agent.name}
            </h1>
            <AgentStatusBadge state={agent.lifecycleState} hasError={hasError} />
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="font-mono">{truncateUuid(agent.id)}</span>
            <span className="h-3 w-px bg-slate-200 dark:bg-primary/20" />
            <span>{agent.role}</span>
            {agent.description && (
              <>
                <span className="hidden h-3 w-px bg-slate-200 dark:bg-primary/20 sm:block" />
                <span className="hidden truncate sm:block">{agent.description}</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="flex items-center gap-2">
        {onPause && (
          <button
            onClick={onPause}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            <span className="material-symbols-outlined text-[18px]">pause_circle</span>
            Pause
          </button>
        )}
        {onTerminate && (
          <button
            onClick={onTerminate}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
          >
            <span className="material-symbols-outlined text-[18px]">cancel</span>
            Terminate
          </button>
        )}
        <Link
          href={`/agents/${agent.id}/browser`}
          className="hidden items-center gap-2 rounded-lg border border-slate-200 bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700 sm:flex"
        >
          <span className="material-symbols-outlined text-[18px]">web</span>
          Browser
        </Link>
      </div>
    </div>
  )
}
