"use client"

import { useCallback, useState } from "react"

import { AccessRequestQueue } from "@/components/access-request-queue"
import { InviteUserModal } from "@/components/invite-user-modal"
import { EmptyState } from "@/components/layout/empty-state"
import { PairingCodeModal } from "@/components/pairing-code-modal"
import { useApiQuery } from "@/hooks/use-api"
import { listAgentUsers, revokeUserGrant } from "@/lib/api-client"
import type { UserGrant } from "@/lib/schemas/users"

// ---------------------------------------------------------------------------
// Origin badge color mapping
// ---------------------------------------------------------------------------

const ORIGIN_STYLES: Record<string, string> = {
  pairing_code: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  dashboard_invite: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  auto_team: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  auto_open: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  approval: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
}

const ORIGIN_LABELS: Record<string, string> = {
  pairing_code: "Pairing Code",
  dashboard_invite: "Invite",
  auto_team: "Team",
  auto_open: "Open",
  approval: "Approved",
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20

interface AgentUsersTabProps {
  agentId: string
}

export function AgentUsersTab({ agentId }: AgentUsersTabProps): React.JSX.Element {
  const [page, setPage] = useState(0)
  const {
    data: usersData,
    isLoading,
    refetch: refetchUsers,
  } = useApiQuery(
    () => listAgentUsers(agentId, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    [agentId, page],
  )

  const [pairingOpen, setPairingOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)

  const grants: UserGrant[] = usersData?.grants ?? []
  const total = usersData?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const handleRevoke = useCallback(
    async (grantId: string) => {
      setRevoking(grantId)
      try {
        await revokeUserGrant(agentId, grantId)
        setConfirmRevoke(null)
        await refetchUsers()
      } catch {
        // Error is shown via refetch state
      } finally {
        setRevoking(null)
      }
    },
    [agentId, refetchUsers],
  )

  const handleInviteSuccess = useCallback(() => {
    setInviteOpen(false)
    void refetchUsers()
  }, [refetchUsers])

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
          <span className="material-symbols-outlined text-lg text-primary">group</span>
        </div>
        <div className="mr-auto">
          <h3 className="text-sm font-bold text-white">Users</h3>
          <p className="text-xs text-slate-500">Manage user access for this agent</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPairingOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <span className="material-symbols-outlined text-[16px]">link</span>
            Generate Pairing Code
          </button>
          <button
            onClick={() => setInviteOpen(true)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90"
          >
            <span className="material-symbols-outlined text-[16px]">person_add</span>
            Invite User
          </button>
        </div>
      </div>

      {/* Pending approval queue */}
      <AccessRequestQueue agentId={agentId} onResolved={() => void refetchUsers()} />

      {/* Grants table */}
      <div className="max-w-5xl">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800"
              />
            ))}
          </div>
        ) : grants.length === 0 ? (
          <EmptyState
            icon="group"
            title="No authorized users"
            description="Invite users or generate a pairing code to grant access to this agent."
            actionLabel="Invite User"
            onAction={() => setInviteOpen(true)}
          />
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50">
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                      User
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Access
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Origin
                    </th>
                    <th className="hidden px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500 lg:table-cell">
                      Granted
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {grants.map((grant) => (
                    <tr key={grant.id} className="group transition-colors hover:bg-primary/5">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex size-7 items-center justify-center rounded-full bg-slate-200 dark:bg-slate-700">
                            <span className="material-symbols-outlined text-xs text-slate-500">
                              person
                            </span>
                          </div>
                          <span className="font-mono text-xs text-slate-900 dark:text-white">
                            {grant.user_account_id.slice(0, 12)}...
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                            grant.access_level === "write"
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "bg-slate-500/10 text-slate-600 dark:text-slate-400"
                          }`}
                        >
                          {grant.access_level}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            ORIGIN_STYLES[grant.origin] ?? "bg-slate-500/10 text-slate-500"
                          }`}
                        >
                          {ORIGIN_LABELS[grant.origin] ?? grant.origin}
                        </span>
                      </td>
                      <td className="hidden px-4 py-3 text-xs text-slate-500 lg:table-cell">
                        {new Date(grant.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {confirmRevoke === grant.id ? (
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => void handleRevoke(grant.id)}
                              disabled={revoking === grant.id}
                              className="rounded-lg bg-red-500 px-3 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                            >
                              {revoking === grant.id ? "Revoking..." : "Confirm"}
                            </button>
                            <button
                              onClick={() => setConfirmRevoke(null)}
                              className="rounded-lg border border-slate-300 px-3 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:text-slate-400"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmRevoke(grant.id)}
                            className="rounded-lg px-2 py-1 text-[11px] font-medium text-red-500 opacity-0 transition-all hover:bg-red-500/10 group-hover:opacity-100"
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

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <p className="text-xs text-slate-500">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of{" "}
                  {total}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-400"
                  >
                    Previous
                  </button>
                  <span className="text-xs text-slate-500">
                    Page {page + 1} of {totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-400"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Modals */}
      <PairingCodeModal
        open={pairingOpen}
        agentId={agentId}
        onClose={() => setPairingOpen(false)}
      />
      <InviteUserModal
        open={inviteOpen}
        agentId={agentId}
        onClose={() => setInviteOpen(false)}
        onSuccess={handleInviteSuccess}
      />
    </div>
  )
}
