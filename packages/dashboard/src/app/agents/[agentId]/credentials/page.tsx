"use client"

import Link from "next/link"
import { use } from "react"

import { CredentialBindingPanel } from "@/components/agents/credential-binding"
import { useApiQuery } from "@/hooks/use-api"
import { getAgent } from "@/lib/api-client"

interface CredentialsPageProps {
  params: Promise<{ agentId: string }>
}

export default function AgentCredentialsPage({ params }: CredentialsPageProps): React.JSX.Element {
  const { agentId } = use(params)
  const { data: agent } = useApiQuery(() => getAgent(agentId), [agentId])

  const agentName = agent?.name ?? agentId

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/agents" className="text-slate-400 transition-colors hover:text-primary">
          Agents
        </Link>
        <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
        <Link
          href={`/agents/${agentId}`}
          className="text-slate-400 transition-colors hover:text-primary"
        >
          {agentName}
        </Link>
        <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
        <span className="flex items-center gap-1.5 font-bold text-white">
          <span className="material-symbols-outlined text-sm text-primary">lock</span>
          Credentials
        </span>
      </nav>

      {/* Page header */}
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
          <span className="material-symbols-outlined text-lg text-primary">lock</span>
        </div>
        <div>
          <h1 className="font-display text-xl font-black tracking-tight text-white lg:text-2xl">
            Credentials
          </h1>
          <p className="text-xs text-slate-500">Manage which credentials are bound to this agent</p>
        </div>
      </div>

      {/* Panel */}
      <div className="max-w-2xl">
        <CredentialBindingPanel agentId={agentId} />
      </div>
    </div>
  )
}
