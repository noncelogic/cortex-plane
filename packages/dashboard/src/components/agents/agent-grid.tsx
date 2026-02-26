"use client"

import type { AgentSummary } from "@/lib/api-client"

import { AgentCard, type AgentMetrics } from "./agent-card"

interface AgentGridProps {
  agents: AgentSummary[]
  metricsMap: Record<string, AgentMetrics>
}

export function AgentGrid({ agents, metricsMap }: AgentGridProps): React.JSX.Element {
  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-surface-border p-12 text-center text-text-muted">
        No agents registered. Deploy a new agent to see it here.
      </div>
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
