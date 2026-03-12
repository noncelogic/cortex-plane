"use client"

import Link from "next/link"

import type { McpServer } from "@/lib/api-client"

import { McpHealthBadge } from "./McpHealthBadge"

function transportLabel(transport: string): string {
  return transport === "streamable-http" ? "HTTP" : "stdio"
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "Never"
  const diff = Date.now() - new Date(iso).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

interface McpServerCardProps {
  server: McpServer
  onToggleStatus?: (id: string, newStatus: "DISABLED" | "PENDING") => void
  toggling?: boolean
}

export function McpServerCard({
  server,
  onToggleStatus,
  toggling,
}: McpServerCardProps): React.JSX.Element {
  const isDisabled = server.status === "DISABLED"
  const toolCount = server.tool_count ?? 0

  return (
    <div className="group flex flex-col rounded-xl border border-slate-200 bg-white transition-all hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 dark:border-slate-800 dark:bg-slate-900/40 dark:hover:border-primary/30">
      <Link href={`/mcp-servers/${server.id}`} className="flex flex-1 flex-col p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <span className="material-symbols-outlined text-[20px] text-primary">dns</span>
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-sm font-bold text-text-main dark:text-white group-hover:text-primary transition-colors">
                {server.name}
              </h3>
              <p className="truncate text-xs text-text-muted">{server.slug}</p>
            </div>
          </div>
          <McpHealthBadge status={server.status} />
        </div>

        {/* Description */}
        {server.description && (
          <p className="mt-3 line-clamp-2 text-xs text-text-muted leading-relaxed">
            {server.description}
          </p>
        )}

        {/* Error message preview */}
        {server.error_message && (
          <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-red-500/5 px-2.5 py-2">
            <span className="material-symbols-outlined mt-0.5 text-[12px] text-red-500">error</span>
            <p className="line-clamp-1 text-[11px] text-red-400">{server.error_message}</p>
          </div>
        )}

        {/* Stats row */}
        <div className="mt-auto pt-4 flex items-center gap-4 border-t border-slate-100 dark:border-slate-800 mt-4">
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[14px] text-text-muted">
              swap_horiz
            </span>
            <span className="text-xs font-medium text-text-muted">
              {transportLabel(server.transport)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[14px] text-text-muted">build</span>
            <span className="text-xs font-medium text-text-muted">
              {toolCount} {toolCount === 1 ? "tool" : "tools"}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[14px] text-text-muted">schedule</span>
            <span className="text-xs font-medium text-text-muted">
              {timeAgo(server.last_healthy_at)}
            </span>
          </div>
        </div>
      </Link>

      {/* Quick actions bar */}
      {onToggleStatus && (
        <div className="border-t border-slate-100 px-5 py-3 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
              Quick Actions
            </span>
            <button
              onClick={(e) => {
                e.preventDefault()
                onToggleStatus(server.id, isDisabled ? "PENDING" : "DISABLED")
              }}
              disabled={toggling}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all disabled:opacity-50 ${
                isDisabled
                  ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400"
                  : "border border-slate-200 bg-slate-100 text-text-muted hover:border-red-500/20 hover:bg-red-500/10 hover:text-red-500 dark:border-slate-700 dark:bg-slate-800"
              }`}
            >
              {toggling ? (
                <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <span className="material-symbols-outlined text-[14px]">
                  {isDisabled ? "power_settings_new" : "stop_circle"}
                </span>
              )}
              {isDisabled ? "Enable" : "Disable"}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
