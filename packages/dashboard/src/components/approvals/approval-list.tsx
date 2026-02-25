"use client"

import type { ApprovalRequest, ApprovalStatus } from "@/lib/api-client"

import { ApprovalCard } from "./approval-card"

interface ApprovalListProps {
  filter?: ApprovalStatus
}

export function ApprovalList({ filter }: ApprovalListProps): React.JSX.Element {
  // TODO: fetch from API, subscribe to SSE
  const approvals: ApprovalRequest[] = []
  void filter

  if (approvals.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-700 p-6 text-center text-sm text-gray-500">
        No approvals pending.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} />
      ))}
    </div>
  )
}
