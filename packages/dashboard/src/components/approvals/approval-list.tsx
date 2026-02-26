"use client"

import type { ApprovalRequest, ApprovalStatus } from "@/lib/api-client"

import { ApprovalCard } from "./approval-card"

interface ApprovalListProps {
  approvals: ApprovalRequest[]
  selectedId?: string | null
  onSelect?: (id: string) => void
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
  onRequestContext?: (id: string) => void
  filter?: ApprovalStatus | "ALL"
  riskFilter?: string
}

export function ApprovalList({
  approvals,
  selectedId,
  onSelect,
  onApprove,
  onReject,
  onRequestContext,
  filter = "ALL",
  riskFilter = "ALL",
}: ApprovalListProps): React.JSX.Element {
  const filtered = approvals.filter((a) => {
    if (filter !== "ALL" && a.status !== filter) return false
    if (riskFilter !== "ALL") {
      const t = a.actionType.toLowerCase()
      if (
        riskFilter === "CRITICAL" &&
        !t.includes("delete") &&
        !t.includes("deploy") &&
        !t.includes("prod")
      )
        return false
      if (
        riskFilter === "MEDIUM" &&
        !t.includes("scale") &&
        !t.includes("update") &&
        !t.includes("modify")
      )
        return false
      if (
        riskFilter === "LOW" &&
        (t.includes("delete") ||
          t.includes("deploy") ||
          t.includes("prod") ||
          t.includes("scale") ||
          t.includes("update") ||
          t.includes("modify"))
      )
        return false
    }
    return true
  })

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-6 flex size-48 items-center justify-center rounded-full border-2 border-dashed border-surface-border">
          <span className="material-symbols-outlined text-6xl text-text-muted">verified_user</span>
        </div>
        <h3 className="mb-2 text-lg font-bold text-text-main">All Clear</h3>
        <p className="max-w-sm text-text-muted">
          No approval requests match the current filters. Adjust your filters or check back later.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {filtered.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          selected={selectedId === approval.id}
          onSelect={onSelect}
          onApprove={onApprove}
          onReject={onReject}
          onRequestContext={onRequestContext}
        />
      ))}
    </div>
  )
}
