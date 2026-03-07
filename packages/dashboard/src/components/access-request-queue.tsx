"use client"

import { useCallback, useState } from "react"

import { useApiQuery } from "@/hooks/use-api"
import { listAccessRequests, resolveAccessRequest } from "@/lib/api-client"
import type { AccessRequest } from "@/lib/schemas/users"

interface AccessRequestQueueProps {
  agentId: string
  onResolved?: () => void
}

export function AccessRequestQueue({
  agentId,
  onResolved,
}: AccessRequestQueueProps): React.JSX.Element {
  const { data, isLoading, refetch } = useApiQuery(
    () => listAccessRequests(agentId, { status: "pending", limit: 50 }),
    [agentId],
  )

  const [resolving, setResolving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleResolve = useCallback(
    async (requestId: string, status: "approved" | "denied") => {
      setResolving(requestId)
      setError(null)
      try {
        await resolveAccessRequest(agentId, requestId, { status })
        await refetch()
        onResolved?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to resolve request")
      } finally {
        setResolving(null)
      }
    },
    [agentId, refetch, onResolved],
  )

  const requests: AccessRequest[] = data?.requests ?? []
  const total = data?.total ?? 0

  if (isLoading) {
    return (
      <div className="animate-pulse rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <div className="h-4 w-32 rounded bg-slate-200 dark:bg-slate-700" />
      </div>
    )
  }

  if (total === 0) return <></>

  return (
    <div className="rounded-xl border border-amber-200/50 bg-amber-500/5 dark:border-amber-700/50">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-amber-200/50 px-4 py-3 dark:border-amber-700/50">
        <span className="material-symbols-outlined text-lg text-amber-500">pending_actions</span>
        <h3 className="text-sm font-bold text-slate-900 dark:text-white">Pending Approvals</h3>
        <span className="ml-auto flex size-5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white">
          {total}
        </span>
      </div>

      {error && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-500">
          <span className="material-symbols-outlined text-[16px]">error</span>
          {error}
        </div>
      )}

      {/* Request list */}
      <div className="divide-y divide-amber-200/30 dark:divide-amber-700/30">
        {requests.map((req) => (
          <div key={req.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex size-8 items-center justify-center rounded-full bg-slate-200 dark:bg-slate-700">
              <span className="material-symbols-outlined text-sm text-slate-500">person</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-900 dark:text-white">
                {req.user_account_id.slice(0, 12)}...
              </p>
              {req.message_preview && (
                <p className="truncate text-xs text-slate-500">{req.message_preview}</p>
              )}
              <p className="text-[10px] text-slate-400">
                {new Date(req.created_at).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleResolve(req.id, "approved")}
                disabled={resolving === req.id}
                className="flex items-center gap-1 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-600 transition-colors hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-400"
              >
                <span className="material-symbols-outlined text-[14px]">check</span>
                Approve
              </button>
              <button
                onClick={() => void handleResolve(req.id, "denied")}
                disabled={resolving === req.id}
                className="flex items-center gap-1 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-500 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
                Deny
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
