import type { AgentLifecycleState } from "@/lib/api-client"

const stateStyles: Record<
  AgentLifecycleState,
  { dot: string; bg: string; text: string; border: string }
> = {
  BOOTING: {
    dot: "bg-yellow-400",
    bg: "bg-yellow-500/10",
    text: "text-yellow-400",
    border: "border-yellow-500/20",
  },
  HYDRATING: {
    dot: "bg-blue-400",
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/20",
  },
  READY: {
    dot: "bg-emerald-500",
    bg: "bg-emerald-500/10",
    text: "text-emerald-500 dark:text-emerald-400",
    border: "border-emerald-500/20",
  },
  EXECUTING: {
    dot: "bg-primary animate-pulse",
    bg: "bg-primary/10",
    text: "text-primary",
    border: "border-primary/20",
  },
  DRAINING: {
    dot: "bg-orange-500",
    bg: "bg-orange-500/10",
    text: "text-orange-500 dark:text-orange-400",
    border: "border-orange-500/20",
  },
  TERMINATED: {
    dot: "bg-slate-500",
    bg: "bg-slate-500/10",
    text: "text-slate-500",
    border: "border-slate-500/20",
  },
}

/** Extra state for ERROR display (not in AgentLifecycleState enum but shown in UI). */
const errorStyle = {
  dot: "bg-red-500",
  bg: "bg-red-500/10",
  text: "text-red-500 dark:text-red-400",
  border: "border-red-500/20",
}

interface AgentStatusBadgeProps {
  state: AgentLifecycleState
  hasError?: boolean
}

export function AgentStatusBadge({ state, hasError }: AgentStatusBadgeProps): React.JSX.Element {
  const style = hasError ? errorStyle : stateStyles[state]
  const label = hasError ? "ERROR" : state

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${style.bg} ${style.text} ${style.border}`}
    >
      <span className={`inline-block size-1.5 rounded-full ${style.dot}`} />
      {label}
    </span>
  )
}
