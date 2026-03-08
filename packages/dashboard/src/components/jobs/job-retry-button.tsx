"use client"

import { useCallback, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { retryJob } from "@/lib/api-client"

interface JobRetryButtonProps {
  jobId: string
  onRetried?: () => void
  variant?: "inline" | "full"
}

export function JobRetryButton({
  jobId,
  onRetried,
  variant = "inline",
}: JobRetryButtonProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const { execute, isLoading, error } = useApi(
    retryJob as (...args: unknown[]) => Promise<{ jobId: string; status: "retrying" }>,
  )
  const [success, setSuccess] = useState(false)

  const handleRetry = useCallback(async () => {
    const result = await execute(jobId)
    if (result) {
      setSuccess(true)
      setConfirming(false)
      onRetried?.()
      setTimeout(() => setSuccess(false), 2000)
    }
  }, [execute, jobId, onRetried])

  if (success) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-500">
        <span className="material-symbols-outlined text-sm">check</span>
        Retried
      </span>
    )
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-red-400">{error}</span>}
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={isLoading}
          className="rounded-lg border border-surface-border px-3 py-1.5 text-xs font-bold text-text-muted transition-colors hover:bg-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={isLoading}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white shadow-sm shadow-primary/20 transition-all hover:bg-primary/90 disabled:opacity-50"
        >
          {isLoading ? (
            <span className="material-symbols-outlined animate-spin text-sm">sync</span>
          ) : (
            <span className="material-symbols-outlined text-sm">replay</span>
          )}
          {isLoading ? "Retrying..." : "Confirm Retry"}
        </button>
      </div>
    )
  }

  if (variant === "full") {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-white shadow-md shadow-primary/20 transition-all hover:bg-primary/90 active:scale-95"
      >
        <span className="material-symbols-outlined text-lg">replay</span>
        Retry Job
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary transition-all hover:bg-primary/20"
      title="Retry job"
    >
      <span className="material-symbols-outlined text-xl leading-none">replay</span>
    </button>
  )
}
