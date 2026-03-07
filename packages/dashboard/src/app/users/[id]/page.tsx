"use client"

import Link from "next/link"
import { use, useCallback, useState } from "react"

import { EmptyState } from "@/components/layout/empty-state"
import { Skeleton } from "@/components/layout/skeleton"
import { Badge } from "@/components/ui/badge"
import { Panel } from "@/components/ui/panel"
import { UserIdentityCard } from "@/components/user-identity-card"
import { UserUsageChart } from "@/components/user-usage-chart"
import { useApi, useApiQuery } from "@/hooks/use-api"
import type { UserGrant } from "@/lib/api/users"
import { getUser, revokeUserGrant } from "@/lib/api/users"

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface UserDetailPageProps {
  params: Promise<{ id: string }>
}

export default function UserDetailPage({ params }: UserDetailPageProps): React.JSX.Element {
  const { id: userId } = use(params)
  const { data, isLoading, error, errorCode, refetch } = useApiQuery(
    () => getUser(userId),
    [userId],
  )

  if (isLoading) {
    return <UserDetailSkeleton />
  }

  if (error) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
        <Breadcrumb userId={userId} />
        <div className="rounded-xl bg-danger/10 px-6 py-4 text-sm text-danger">
          {errorCode === "NOT_FOUND" ? "User not found." : `Failed to load user: ${error}`}
        </div>
      </div>
    )
  }

  if (!data) return <UserDetailSkeleton />

  const { user, channelMappings, grants } = data

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      <Breadcrumb userId={userId} userName={user.display_name} />

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        {/* Left column: identity + usage */}
        <div className="flex flex-col gap-6">
          <UserIdentityCard user={user} channels={channelMappings} />
          <UserUsageChart userId={userId} />
        </div>

        {/* Right column: agent access table + actions */}
        <div className="flex flex-col gap-6">
          <AgentAccessTable grants={grants} onRevoke={() => void refetch()} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

function Breadcrumb({ userId, userName }: { userId: string; userName?: string | null }) {
  return (
    <nav className="flex items-center gap-2 text-sm">
      <Link href="/agents" className="text-slate-400 transition-colors hover:text-primary">
        Agents
      </Link>
      <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
      <span className="flex items-center gap-1.5 font-bold text-white">
        <span className="material-symbols-outlined text-sm text-primary">person</span>
        {userName ?? userId}
      </span>
    </nav>
  )
}

// ---------------------------------------------------------------------------
// Agent access table
// ---------------------------------------------------------------------------

const ORIGIN_LABELS: Record<string, string> = {
  pairing_code: "Pairing code",
  dashboard_invite: "Dashboard invite",
  auto_team: "Auto (team)",
  auto_open: "Auto (open)",
  approval: "Approval",
}

interface AgentAccessTableProps {
  grants: UserGrant[]
  onRevoke: () => void
}

function AgentAccessTable({ grants, onRevoke }: AgentAccessTableProps) {
  const { execute: executeRevoke, isLoading: revoking } = useApi(
    (agentId: unknown, grantId: unknown) => revokeUserGrant(agentId as string, grantId as string),
  )
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const handleRevoke = useCallback(
    async (grant: UserGrant) => {
      await executeRevoke(grant.agent_id, grant.id)
      setConfirmId(null)
      onRevoke()
    },
    [executeRevoke, onRevoke],
  )

  if (grants.length === 0) {
    return (
      <EmptyState
        icon="shield_person"
        title="No agent access"
        description="This user has no active grants to any agents."
      />
    )
  }

  return (
    <Panel className="overflow-hidden">
      <div className="border-b border-surface-border px-5 py-3">
        <h3 className="font-display text-sm font-bold text-text-main">
          Agent access ({grants.length})
        </h3>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-surface-border text-xs text-text-muted">
              <th className="px-5 py-2 font-medium">Agent</th>
              <th className="px-5 py-2 font-medium">Access</th>
              <th className="px-5 py-2 font-medium">Origin</th>
              <th className="px-5 py-2 font-medium">Granted</th>
              <th className="px-5 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((grant) => (
              <tr
                key={grant.id}
                className="border-b border-surface-border last:border-b-0 hover:bg-secondary/50"
              >
                <td className="px-5 py-3">
                  <Link
                    href={`/agents/${grant.agent_id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {grant.agent_id.slice(0, 8)}…
                  </Link>
                </td>
                <td className="px-5 py-3">
                  <Badge variant={grant.access_level === "write" ? "success" : "info"}>
                    {grant.access_level}
                  </Badge>
                </td>
                <td className="px-5 py-3 text-text-muted">
                  {ORIGIN_LABELS[grant.origin] ?? grant.origin}
                </td>
                <td className="px-5 py-3 text-text-muted">
                  {new Date(grant.created_at).toLocaleDateString()}
                </td>
                <td className="px-5 py-3">
                  {confirmId === grant.id ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={revoking}
                        onClick={() => void handleRevoke(grant)}
                        className="rounded bg-danger px-2 py-1 text-xs font-medium text-white hover:bg-danger/80 disabled:opacity-50"
                      >
                        {revoking ? "Revoking…" : "Confirm"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        className="text-xs text-text-muted hover:text-text-main"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmId(grant.id)}
                      className="text-xs text-danger hover:underline"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function UserDetailSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      <Skeleton className="h-5 w-48" />
      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  )
}
