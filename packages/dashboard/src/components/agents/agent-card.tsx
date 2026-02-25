"use client"

import Link from "next/link"

import type { AgentSummary } from "@/lib/api-client"

import { AgentStatusBadge } from "./agent-status-badge"

interface AgentCardProps {
  agent: AgentSummary
}

export function AgentCard({ agent }: AgentCardProps): React.JSX.Element {
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="block rounded-lg border border-gray-800 bg-gray-900 p-4 transition-colors hover:border-gray-700"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold text-gray-100">{agent.name}</h3>
        <AgentStatusBadge state={agent.lifecycleState} />
      </div>
      <p className="text-sm text-gray-400">{agent.role}</p>
      {agent.currentJobId && (
        <p className="mt-2 truncate text-xs text-gray-500">Job: {agent.currentJobId}</p>
      )}
    </Link>
  )
}
