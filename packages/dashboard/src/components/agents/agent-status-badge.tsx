import type { AgentLifecycleState } from "@/lib/api-client"

const stateStyles: Record<AgentLifecycleState, { dot: string; bg: string; text: string }> = {
  BOOTING: { dot: "bg-yellow-400", bg: "bg-yellow-400/10", text: "text-yellow-400" },
  HYDRATING: { dot: "bg-blue-400", bg: "bg-blue-400/10", text: "text-blue-400" },
  READY: { dot: "bg-green-400", bg: "bg-green-400/10", text: "text-green-400" },
  EXECUTING: { dot: "bg-green-400 animate-pulse", bg: "bg-green-400/10", text: "text-green-400" },
  DRAINING: { dot: "bg-orange-400", bg: "bg-orange-400/10", text: "text-orange-400" },
  TERMINATED: { dot: "bg-gray-500", bg: "bg-gray-500/10", text: "text-gray-500" },
}

interface AgentStatusBadgeProps {
  state: AgentLifecycleState
}

export function AgentStatusBadge({ state }: AgentStatusBadgeProps): React.JSX.Element {
  const style = stateStyles[state]

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {state}
    </span>
  )
}
