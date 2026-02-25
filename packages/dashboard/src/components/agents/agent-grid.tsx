import type { AgentSummary } from "@/lib/api-client"

import { AgentCard } from "./agent-card"

// Server Component — fetches agents at request time
export function AgentGrid(): React.JSX.Element {
  // TODO: fetch from control plane API
  const agents: AgentSummary[] = []

  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-700 p-8 text-center text-gray-500">
        No agents registered. Start an agent to see it here.
      </div>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  )
}
