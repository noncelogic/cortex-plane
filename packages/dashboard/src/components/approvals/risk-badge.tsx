"use client"

type RiskLevel = "CRITICAL" | "MEDIUM" | "LOW"

interface RiskBadgeProps {
  level: RiskLevel
}

const config: Record<RiskLevel, { label: string; icon: string; classes: string }> = {
  CRITICAL: {
    label: "CRITICAL RISK",
    icon: "gpp_maybe",
    classes:
      "bg-red-50 text-red-700 border-red-100 dark:bg-red-900/20 dark:text-red-400 dark:border-red-900/30",
  },
  MEDIUM: {
    label: "MEDIUM RISK",
    icon: "warning",
    classes:
      "bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-900/30",
  },
  LOW: {
    label: "LOW RISK",
    icon: "info",
    classes:
      "bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-900/30",
  },
}

export function RiskBadge({ level }: RiskBadgeProps): React.JSX.Element {
  const c = config[level]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${c.classes}`}
    >
      <span className="material-symbols-outlined text-[14px]">{c.icon}</span>
      {c.label}
    </span>
  )
}

export function RiskDot({ level }: RiskBadgeProps): React.JSX.Element {
  const dotColor =
    level === "CRITICAL" ? "bg-red-500" : level === "MEDIUM" ? "bg-amber-500" : "bg-blue-500"

  return <div className={`size-1.5 rounded-full ${dotColor}`} />
}
