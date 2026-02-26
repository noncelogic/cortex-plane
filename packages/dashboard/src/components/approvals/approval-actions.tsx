"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { approveRequest } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApprovalActionsProps {
  approvalId: string
  onDecided?: (decision: "APPROVED" | "REJECTED") => void
}

type DialogType = "approve" | "reject" | null

// ---------------------------------------------------------------------------
// Confirmation Dialog
// ---------------------------------------------------------------------------

interface ConfirmDialogProps {
  type: "approve" | "reject"
  onConfirm: (reason: string) => void
  onCancel: () => void
  submitting: boolean
}

function ConfirmDialog({
  type,
  onConfirm,
  onCancel,
  submitting,
}: ConfirmDialogProps): React.JSX.Element {
  const [reason, setReason] = useState("")
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onCancel])

  const isApprove = type === "approve"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
        role="presentation"
      />

      {/* Dialog */}
      <div className="relative w-full max-w-md rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
        {/* Icon */}
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

        {/* Reason input */}
        <div className="mb-4">
          <label
            htmlFor="decision-reason"
            className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-text-muted"
          >
            Reason {isApprove ? "(optional)" : "(recommended)"}
          </label>
          <textarea
            ref={inputRef}
            id="decision-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={
              isApprove ? "Approved per standard review..." : "Denied due to security concerns..."
            }
            rows={3}
            className="w-full rounded-lg border border-surface-border bg-bg-light px-3 py-2 text-sm text-text-main placeholder-text-muted transition-colors focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* Actions */}
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
// Main Component
// ---------------------------------------------------------------------------

export function ApprovalActions({
  approvalId,
  onDecided,
}: ApprovalActionsProps): React.JSX.Element {
  const [dialog, setDialog] = useState<DialogType>(null)
  const { execute, isLoading } = useApi((...args: unknown[]) =>
    approveRequest(
      args[0] as string,
      args[1] as "APPROVED" | "REJECTED",
      args[2] as string,
      args[3] as string | undefined,
    ),
  )

  const handleConfirm = useCallback(
    async (reason: string) => {
      if (!dialog) return
      const decision = dialog === "approve" ? ("APPROVED" as const) : ("REJECTED" as const)
      const result = await execute(approvalId, decision, "dashboard-user", reason || undefined)
      if (result) {
        setDialog(null)
        onDecided?.(decision)
      }
    },
    [dialog, approvalId, execute, onDecided],
  )

  return (
    <>
      {/* Inline action buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setDialog("reject")}
          className="rounded-lg px-4 py-2 text-xs font-bold uppercase tracking-wider text-red-500 transition-colors hover:bg-red-500/10"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => setDialog("approve")}
          className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-md shadow-primary/20 transition-all hover:bg-primary/90 active:scale-95"
        >
          <span className="material-symbols-outlined text-[16px]">check_circle</span>
          Approve
        </button>
      </div>

      {/* Confirmation dialog */}
      {dialog && (
        <ConfirmDialog
          type={dialog}
          onConfirm={(reason) => void handleConfirm(reason)}
          onCancel={() => setDialog(null)}
          submitting={isLoading}
        />
      )}
    </>
  )
}
