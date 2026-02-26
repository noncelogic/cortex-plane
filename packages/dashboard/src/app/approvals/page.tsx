"use client"

import { useCallback, useMemo, useState } from "react"

import { ApprovalActions } from "@/components/approvals/approval-actions"
import { ApprovalList } from "@/components/approvals/approval-list"
import type { AuditEntry } from "@/components/approvals/audit-drawer"
import { AuditDrawer } from "@/components/approvals/audit-drawer"
import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { useApi, useApiQuery } from "@/hooks/use-api"
import { useApprovalStream } from "@/hooks/use-approval-stream"
import type { ApprovalRequest, ApprovalStatus } from "@/lib/api-client"
import { approveRequest, listApprovals } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Risk classification (shared with ApprovalCard)
// ---------------------------------------------------------------------------

type RiskLevel = "CRITICAL" | "MEDIUM" | "LOW"

function classifyRisk(approval: ApprovalRequest): RiskLevel {
  const t = approval.actionType.toLowerCase()
  if (t.includes("delete") || t.includes("deploy") || t.includes("prod")) return "CRITICAL"
  if (t.includes("scale") || t.includes("update") || t.includes("modify")) return "MEDIUM"
  return "LOW"
}

// ---------------------------------------------------------------------------
// Filter config
// ---------------------------------------------------------------------------

type StatusFilter = ApprovalStatus | "ALL"
type RiskFilter = RiskLevel | "ALL"

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "ALL", label: "All Status" },
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "EXPIRED", label: "Expired" },
]

const RISK_OPTIONS: { value: RiskFilter; label: string }[] = [
  { value: "ALL", label: "All Risk" },
  { value: "CRITICAL", label: "Critical" },
  { value: "MEDIUM", label: "Medium" },
  { value: "LOW", label: "Low" },
]

// ---------------------------------------------------------------------------
// Header status pill counts
// ---------------------------------------------------------------------------

function StatusPill({
  count,
  label,
  variant,
}: {
  count: number
  label: string
  variant: "critical" | "warning" | "info"
}): React.JSX.Element | null {
  if (count === 0) return null
  const cls =
    variant === "critical"
      ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
      : variant === "warning"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
        : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"

  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {count} {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-slate-200 bg-surface-light p-5 dark:border-slate-800 dark:bg-surface-dark"
        >
          <div className="flex gap-5">
            <div className="size-10 rounded-full bg-slate-200 dark:bg-slate-700" />
            <div className="flex-1 space-y-3">
              <div className="flex items-center gap-2">
                <div className="h-5 w-24 rounded bg-slate-200 dark:bg-slate-700" />
                <div className="h-5 w-16 rounded bg-slate-200 dark:bg-slate-700" />
              </div>
              <div className="h-5 w-3/4 rounded bg-slate-200 dark:bg-slate-700" />
              <div className="h-4 w-1/2 rounded bg-slate-200 dark:bg-slate-700" />
              <div className="flex gap-2">
                <div className="h-6 w-20 rounded bg-slate-200 dark:bg-slate-700" />
                <div className="h-6 w-24 rounded bg-slate-200 dark:bg-slate-700" />
                <div className="h-6 w-16 rounded bg-slate-200 dark:bg-slate-700" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mobile action bar
// ---------------------------------------------------------------------------

function MobileActionBar({
  approvalId,
  onDecided,
}: {
  approvalId: string
  onDecided: (decision: "APPROVED" | "REJECTED") => void
}): React.JSX.Element {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-surface-light/95 px-4 py-3 backdrop-blur-md dark:border-slate-800 dark:bg-surface-dark/95 lg:hidden">
      <ApprovalActions approvalId={approvalId} onDecided={onDecided} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ApprovalsPage(): React.JSX.Element {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL")
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("ALL")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Fetch approvals from API
  const { data, isLoading, error, errorCode, refetch } = useApiQuery(
    () => listApprovals({ limit: 100 }),
    [],
  )

  // Real-time stream
  const { events: streamEvents, connected, pendingCount } = useApprovalStream()

  // Decision API
  const { execute: decide } = useApi((...args: unknown[]) =>
    approveRequest(
      args[0] as string,
      args[1] as "APPROVED" | "REJECTED",
      args[2] as string,
      args[3] as string | undefined,
    ),
  )

  // Merge SSE events into the approval list
  const approvals = useMemo(() => {
    const base = data?.approvals ?? []
    if (streamEvents.length === 0) return base

    const map = new Map<string, ApprovalRequest>()
    for (const a of base) map.set(a.id, a)

    for (const ev of streamEvents) {
      if (ev.type === "created") {
        const d = ev.data
        if (!map.has(d.approvalRequestId)) {
          map.set(d.approvalRequestId, {
            id: d.approvalRequestId,
            jobId: d.jobId,
            agentId: d.agentId,
            status: "PENDING",
            actionType: d.actionType,
            actionSummary: d.actionSummary,
            requestedAt: d.timestamp,
            expiresAt: d.expiresAt,
          })
        }
      } else if (ev.type === "decided") {
        const d = ev.data
        const existing = map.get(d.approvalRequestId)
        if (existing) {
          map.set(d.approvalRequestId, {
            ...existing,
            status: d.decision as ApprovalStatus,
            decision: d.decision as "APPROVED" | "REJECTED",
            decidedBy: d.decidedBy,
            decidedAt: d.timestamp,
          })
        }
      } else if (ev.type === "expired") {
        const d = ev.data
        const existing = map.get(d.approvalRequestId)
        if (existing) {
          map.set(d.approvalRequestId, { ...existing, status: "EXPIRED" })
        }
      }
    }

    // Sort: pending first (by expiry ascending), then decided (by decidedAt descending)
    return Array.from(map.values()).sort((a, b) => {
      if (a.status === "PENDING" && b.status !== "PENDING") return -1
      if (a.status !== "PENDING" && b.status === "PENDING") return 1
      if (a.status === "PENDING" && b.status === "PENDING") {
        return new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime()
      }
      return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()
    })
  }, [data, streamEvents])

  // Risk counts for header pills
  const riskCounts = useMemo(() => {
    const pending = approvals.filter((a) => a.status === "PENDING")
    return {
      critical: pending.filter((a) => classifyRisk(a) === "CRITICAL").length,
      medium: pending.filter((a) => classifyRisk(a) === "MEDIUM").length,
      low: pending.filter((a) => classifyRisk(a) === "LOW").length,
    }
  }, [approvals])

  // Build audit entries from stream events + existing approvals
  const auditEntries = useMemo<AuditEntry[]>(() => {
    const entries: AuditEntry[] = []

    // From existing approvals that have been decided
    for (const a of approvals) {
      if (a.status !== "PENDING") {
        entries.push({
          id: `${a.id}-decision`,
          type:
            a.status === "APPROVED" ? "approved" : a.status === "REJECTED" ? "rejected" : "expired",
          actor: a.decidedBy ?? "System",
          timestamp: a.decidedAt ?? a.requestedAt,
          reason: a.reason,
          channel: "dashboard",
        })
      }
      entries.push({
        id: `${a.id}-request`,
        type: "requested",
        actor: a.agentId ?? "Unknown",
        timestamp: a.requestedAt,
      })
    }

    // Sort newest first
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    return entries.slice(0, 50)
  }, [approvals])

  // Handlers
  const handleApprove = useCallback(
    async (id: string) => {
      await decide(id, "APPROVED", "dashboard-user")
      void refetch()
    },
    [decide, refetch],
  )

  const handleReject = useCallback(
    async (id: string) => {
      await decide(id, "REJECTED", "dashboard-user")
      void refetch()
    },
    [decide, refetch],
  )

  const handleDecided = useCallback(() => {
    void refetch()
    setSelectedId(null)
  }, [refetch])

  const selectedApproval = approvals.find((a) => a.id === selectedId)

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex-shrink-0 border-b border-slate-200 bg-surface-light px-6 py-4 dark:border-slate-800 dark:bg-surface-dark">
          <div className="mx-auto max-w-4xl">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <h1 className="font-display text-xl font-bold text-text-main dark:text-white">
                  Approvals Queue
                </h1>
                <div className="flex items-center gap-2">
                  <StatusPill count={riskCounts.critical} label="Critical" variant="critical" />
                  <StatusPill count={riskCounts.medium} label="Warning" variant="warning" />
                  <StatusPill count={riskCounts.low} label="Low" variant="info" />
                </div>
              </div>

              {/* Connection status */}
              <div className="flex items-center gap-2">
                <div
                  className={`size-2 rounded-full ${connected ? "bg-emerald-500" : "bg-slate-400"}`}
                />
                <span className="text-xs text-text-muted">
                  {connected ? "Live" : "Reconnecting…"}
                </span>
                {pendingCount > 0 && (
                  <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-white">
                    {pendingCount}
                  </span>
                )}
              </div>
            </div>

            {/* Filters */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="rounded-lg border border-slate-200 bg-surface-light px-3 py-2 text-sm font-medium text-text-main transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-surface-dark dark:text-white"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <select
                value={riskFilter}
                onChange={(e) => setRiskFilter(e.target.value as RiskFilter)}
                className="rounded-lg border border-slate-200 bg-surface-light px-3 py-2 text-sm font-medium text-text-main transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-slate-700 dark:bg-surface-dark dark:text-white"
              >
                {RISK_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => void refetch()}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm shadow-primary/30 transition-colors hover:bg-primary/90"
              >
                <span className="material-symbols-outlined text-[16px]">refresh</span>
                Refresh
              </button>
            </div>
          </div>
        </header>

        {/* Card list */}
        <div className="flex-1 overflow-y-auto p-6 pb-24 scrollbar-hide lg:pb-6">
          <div className="mx-auto max-w-4xl">
            {isLoading ? (
              <LoadingSkeleton />
            ) : error ? (
              <ApiErrorBanner error={error} errorCode={errorCode} onRetry={() => void refetch()} />
            ) : approvals.length === 0 ? (
              <EmptyState
                icon="verified_user"
                title="All clear"
                description="No approval requests at the moment. When agents need authorization, requests will appear here."
              />
            ) : (
              <ApprovalList
                approvals={approvals}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onApprove={(id) => void handleApprove(id)}
                onReject={(id) => void handleReject(id)}
                onRequestContext={(id) => setSelectedId(id)}
                filter={statusFilter}
                riskFilter={riskFilter}
              />
            )}
          </div>
        </div>
      </div>

      {/* Audit drawer (desktop) */}
      <AuditDrawer entries={auditEntries} />

      {/* Mobile sticky action bar */}
      {selectedApproval && selectedApproval.status === "PENDING" && (
        <MobileActionBar approvalId={selectedApproval.id} onDecided={handleDecided} />
      )}
    </div>
  )
}
