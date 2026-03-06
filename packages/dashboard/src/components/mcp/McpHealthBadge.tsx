"use client"

import type { McpServerStatus } from "@/lib/api-client"

const STATUS_CONFIG: Record<
  McpServerStatus,
  { label: string; dotClass: string; bgClass: string; textClass: string }
> = {
  ACTIVE: {
    label: "Active",
    dotClass: "bg-emerald-500",
    bgClass: "border-emerald-500/20 bg-emerald-500/10",
    textClass: "text-emerald-600 dark:text-emerald-400",
  },
  PENDING: {
    label: "Pending",
    dotClass: "bg-amber-500",
    bgClass: "border-amber-500/20 bg-amber-500/10",
    textClass: "text-amber-600 dark:text-amber-400",
  },
  DEGRADED: {
    label: "Degraded",
    dotClass: "bg-orange-500",
    bgClass: "border-orange-500/20 bg-orange-500/10",
    textClass: "text-orange-600 dark:text-orange-400",
  },
  ERROR: {
    label: "Error",
    dotClass: "bg-red-500",
    bgClass: "border-red-500/20 bg-red-500/10",
    textClass: "text-red-500",
  },
  DISABLED: {
    label: "Disabled",
    dotClass: "bg-slate-400",
    bgClass: "border-slate-400/20 bg-slate-400/10",
    textClass: "text-slate-500 dark:text-slate-400",
  },
}

interface McpHealthBadgeProps {
  status: McpServerStatus
}

export function McpHealthBadge({ status }: McpHealthBadgeProps): React.JSX.Element {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.PENDING

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${config.bgClass}`}
    >
      <span
        className={`size-1.5 rounded-full ${config.dotClass} ${status === "ACTIVE" ? "animate-pulse" : ""}`}
      />
      <span className={`text-[10px] font-bold uppercase tracking-wider ${config.textClass}`}>
        {config.label}
      </span>
    </span>
  )
}
