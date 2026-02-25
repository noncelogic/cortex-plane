"use client"

import { useState } from "react"

interface ApprovalActionsProps {
  approvalId: string
}

export function ApprovalActions({ approvalId }: ApprovalActionsProps): React.JSX.Element {
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)

  function handleDecision(decision: "APPROVED" | "REJECTED"): void {
    setSubmitting(true)
    try {
      // TODO: wire to api-client
      void approvalId
      void decision
      void reason
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={reason}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setReason(e.target.value)}
        placeholder="Reason (optional)"
        className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-200 placeholder-gray-500"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => handleDecision("APPROVED")}
          disabled={submitting}
          className="rounded bg-success px-3 py-1 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => handleDecision("REJECTED")}
          disabled={submitting}
          className="rounded bg-danger px-3 py-1 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  )
}
