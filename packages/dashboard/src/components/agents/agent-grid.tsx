"use client"

import { EmptyState } from "@/components/layout/empty-state"
import type { AgentSummary } from "@/lib/api-client"

import { AgentCard, type AgentMetrics } from "./agent-card"

interface AgentGridProps {
  agents: AgentSummary[]
  metricsMap: Record<string, AgentMetrics>
}

export function AgentGrid({ agents, metricsMap }: AgentGridProps): React.JSX.Element {
  if (agents.length === 0) {
    return (
      <EmptyState
        icon="search_off"
        title="No agents match"
        description="Try adjusting your search or filters to find agents."
        compact
      />
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} metrics={metricsMap[agent.id]} />
      ))}
    </div>
  )
}
