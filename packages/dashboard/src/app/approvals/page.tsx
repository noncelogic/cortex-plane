"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import { ApprovalActions } from "@/components/approvals/approval-actions"
import { ApprovalList } from "@/components/approvals/approval-list"
import type { AuditEntry } from "@/components/approvals/audit-drawer"
import { AuditDrawer } from "@/components/approvals/audit-drawer"
import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { useApi, useApiQuery } from "@/hooks/use-api"
import { useApprovalStream } from "@/hooks/use-approval-stream"
import type { ApprovalAuditEntry, ApprovalRequest, ApprovalStatus } from "@/lib/api-client"
import { approveRequest, getApprovalAudit, listApprovals } from "@/lib/api-client"

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
// Confirm Dialog (for card-level approve/reject)
// ---------------------------------------------------------------------------

interface CardConfirmState {
  approvalId: string
  type: "approve" | "reject"
}

function CardConfirmDialog({
  state,
  submitting,
  onConfirm,
  onCancel,
}: {
  state: CardConfirmState
  submitting: boolean
  onConfirm: (reason: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [reason, setReason] = useState("")
  const isApprove = state.type === "approve"

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
        role="presentation"
      />
      <div className="relative w-full max-w-md rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <div
            className={`flex size-10 items-center justify-center rounded-full ${
              isApprove ? "bg-emerald-500/10" : "bg-red-500/10"
            }`}
          >
            <span
              className={`material-symbols-outlined text-[20px] ${
                isApprove ? "text-emerald-500" : "text-red-500"
              }`}
            >
              {isApprove ? "check_circle" : "cancel"}
            </span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-text-main">
              {isApprove ? "Approve Request" : "Reject Request"}
            </h3>
            <p className="text-sm text-text-muted">
              {isApprove
                ? "This action will proceed with the requested operation."
                : "This action will deny the requested operation."}
            </p>
          </div>
        </div>
        <div className="mb-4">
          <label
            htmlFor="card-decision-reason"
            className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-text-muted"
          >
            Reason {isApprove ? "(optional)" : "(recommended)"}
          </label>
          <textarea
            id="card-decision-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              isApprove ? "Approved per standard review..." : "Denied due to security concerns..."
            }
            rows={3}
            className="w-full rounded-lg border border-surface-border bg-bg-light px-3 py-2 text-sm text-text-main placeholder-text-muted transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg px-4 py-2 text-xs font-bold uppercase tracking-wider text-text-muted transition-colors hover:bg-secondary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason)}
            disabled={submitting}
            className={`flex items-center gap-2 rounded-lg px-6 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-md transition-all active:scale-95 disabled:opacity-50 ${
              isApprove
                ? "bg-emerald-600 shadow-emerald-600/20 hover:bg-emerald-700"
                : "bg-red-600 shadow-red-600/20 hover:bg-red-700"
            }`}
          >
            {submitting && (
              <span className="material-symbols-outlined animate-spin text-[16px]">
                progress_activity
              </span>
            )}
            {isApprove ? "Confirm Approval" : "Confirm Rejection"}
          </button>
        </div>
      </div>
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
// Map backend audit entries to drawer AuditEntry format
// ---------------------------------------------------------------------------

function mapAuditEntries(raw: ApprovalAuditEntry[]): AuditEntry[] {
  return raw.map((entry) => {
    let type: AuditEntry["type"] = "requested"
    const et = entry.event_type
    if (et === "request_decided") {
      const decision = entry.details?.decision
      type = decision === "APPROVED" ? "approved" : decision === "REJECTED" ? "rejected" : "expired"
    } else if (et === "request_expired") {
      type = "expired"
    } else if (et === "request_created") {
      type = "requested"
    } else if (et === "unauthorized_attempt") {
      type = "rejected"
    }

    return {
      id: entry.id,
      type,
      actor: entry.actor_user_id ?? entry.actor_channel ?? "System",
      timestamp: entry.created_at,
      reason: typeof entry.details?.reason === "string" ? entry.details.reason : undefined,
      channel: entry.actor_channel ?? undefined,
      ipAddress:
        typeof entry.details?.actor === "object" &&
        entry.details.actor !== null &&
        "ip" in entry.details.actor
          ? (entry.details.actor as { ip?: string }).ip
          : undefined,
    }
  })
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ApprovalsPage(): React.JSX.Element {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL")
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("ALL")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<CardConfirmState | null>(null)

  // Fetch approvals from API — wire status filter to query params
  const { data, isLoading, error, errorCode, refetch } = useApiQuery(
    () =>
      listApprovals({
        limit: 100,
        status: statusFilter !== "ALL" ? statusFilter : undefined,
      }),
    [statusFilter],
  )

  // Real-time stream
  const { events: streamEvents, connected, pendingCount } = useApprovalStream()

  // Decision API
  const { execute: decide, isLoading: isDeciding } = useApi((...args: unknown[]) =>
    approveRequest(
      args[0] as string,
      args[1] as "APPROVED" | "REJECTED",
      args[2] as string,
      args[3] as string | undefined,
    ),
  )

  // Fetch audit trail for selected approval
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [auditLoading, setAuditLoading] = useState(false)

  useEffect(() => {
    if (!selectedId) {
      setAuditEntries([])
      return
    }

    let cancelled = false
    setAuditLoading(true)

    getApprovalAudit(selectedId)
      .then((res) => {
        if (!cancelled) {
          setAuditEntries(mapAuditEntries(res.audit))
        }
      })
      .catch(() => {
        if (!cancelled) setAuditEntries([])
      })
      .finally(() => {
        if (!cancelled) setAuditLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedId])

  // Fallback audit entries from approvals list when no approval is selected
  const globalAuditEntries = useMemo<AuditEntry[]>(() => {
    if (selectedId) return [] // Will use per-approval audit entries instead
    const base = data?.approvals ?? []
    const entries: AuditEntry[] = []

    for (const a of base) {
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

    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    return entries.slice(0, 50)
  }, [data, selectedId])

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

  // Handlers — card-level approve/reject now open confirmation dialog
  const handleApprove = useCallback((id: string) => {
    setConfirmState({ approvalId: id, type: "approve" })
  }, [])

  const handleReject = useCallback((id: string) => {
    setConfirmState({ approvalId: id, type: "reject" })
  }, [])

  const handleConfirmDecision = useCallback(
    async (reason: string) => {
      if (!confirmState) return
      const decision =
        confirmState.type === "approve" ? ("APPROVED" as const) : ("REJECTED" as const)
      const result = await decide(
        confirmState.approvalId,
        decision,
        "dashboard-user",
        reason || undefined,
      )
      if (result) {
        setConfirmState(null)
        void refetch()
      }
    },
    [confirmState, decide, refetch],
  )

  const handleDecided = useCallback(() => {
    void refetch()
    setSelectedId(null)
  }, [refetch])

  const selectedApproval = approvals.find((a) => a.id === selectedId)

  // Use per-approval audit entries when selected, otherwise global
  const drawerEntries = selectedId ? auditEntries : globalAuditEntries

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
                onApprove={handleApprove}
                onReject={handleReject}
                onRequestContext={(id) => setSelectedId(id)}
                filter={statusFilter}
                riskFilter={riskFilter}
              />
            )}
          </div>
        </div>
      </div>

      {/* Audit drawer (desktop) */}
      <AuditDrawer
        entries={drawerEntries}
        loading={auditLoading}
        selectedId={selectedId}
        onClose={selectedId ? () => setSelectedId(null) : undefined}
      />

      {/* Confirmation dialog for card-level approve/reject */}
      {confirmState && (
        <CardConfirmDialog
          state={confirmState}
          submitting={isDeciding}
          onConfirm={(reason) => void handleConfirmDecision(reason)}
          onCancel={() => setConfirmState(null)}
        />
      )}

      {/* Mobile sticky action bar */}
      {selectedApproval && selectedApproval.status === "PENDING" && (
        <MobileActionBar approvalId={selectedApproval.id} onDecided={handleDecided} />
      )}
    </div>
  )
}
