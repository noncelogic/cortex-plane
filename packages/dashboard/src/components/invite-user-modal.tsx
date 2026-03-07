"use client"

import { useCallback, useState } from "react"

import { createAgentUserGrant } from "@/lib/api-client"

interface InviteUserModalProps {
  open: boolean
  agentId: string
  onClose: () => void
  onSuccess: () => void
}

export function InviteUserModal({
  open,
  agentId,
  onClose,
  onSuccess,
}: InviteUserModalProps): React.JSX.Element | null {
  const [userId, setUserId] = useState("")
  const [accessLevel, setAccessLevel] = useState<"read" | "write">("write")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resetForm = useCallback(() => {
    setUserId("")
    setAccessLevel("write")
    setError(null)
  }, [])

  const handleClose = useCallback(() => {
    if (submitting) return
    resetForm()
    onClose()
  }, [submitting, resetForm, onClose])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!userId.trim() || submitting) return

      setSubmitting(true)
      setError(null)

      try {
        await createAgentUserGrant(agentId, {
          user_account_id: userId.trim(),
          access_level: accessLevel,
        })
        resetForm()
        onSuccess()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to invite user")
      } finally {
        setSubmitting(false)
      }
    },
    [agentId, userId, accessLevel, submitting, resetForm, onSuccess],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={handleClose} />

      <div className="relative mx-4 w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
              <span className="material-symbols-outlined text-xl text-primary">person_add</span>
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">Invite User</h2>
              <p className="text-xs text-slate-500">Grant a user access to this agent</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="flex size-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {/* User ID */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              User Account ID <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="Enter user account ID"
              disabled={submitting}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>

          {/* Access Level */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Access Level
            </label>
            <select
              value={accessLevel}
              onChange={(e) => setAccessLevel(e.target.value as "read" | "write")}
              disabled={submitting}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            >
              <option value="write">Write</option>
              <option value="read">Read</option>
            </select>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-500">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !userId.trim()}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-lg">person_add</span>
              {submitting ? "Inviting..." : "Invite User"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
