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
      "bg-red-500/10 text-red-500 border-red-500/20",
  },
  MEDIUM: {
    label: "MEDIUM RISK",
    icon: "warning",
    classes:
      "bg-amber-500/10 text-amber-500 border-amber-500/20",
  },
  LOW: {
    label: "LOW RISK",
    icon: "info",
    classes:
      "bg-blue-500/10 text-blue-500 border-blue-500/20",
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
