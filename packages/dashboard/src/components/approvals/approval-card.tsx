"use client"

import type { ApprovalRequest } from "@/lib/api-client"

import { ApprovalActions } from "./approval-actions"

interface ApprovalCardProps {
  approval: ApprovalRequest
}

export function ApprovalCard({ approval }: ApprovalCardProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-warning">{approval.actionType}</span>
        <span className="text-xs text-gray-500">{approval.agentId}</span>
      </div>
      <p className="mb-3 text-sm text-gray-300">{approval.actionSummary}</p>
      {approval.status === "PENDING" && <ApprovalActions approvalId={approval.id} />}
    </div>
  )
}
