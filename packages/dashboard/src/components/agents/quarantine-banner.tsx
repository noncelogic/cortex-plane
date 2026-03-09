"use client"

import { useCallback, useState } from "react"

import { useApiQuery } from "@/hooks/use-api"
import { getAgent, releaseAgent } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// QuarantineBanner — shows a prominent warning when agent is quarantined
// with a Release button that calls releaseAgent and resets circuit breaker.
// ---------------------------------------------------------------------------

interface QuarantineBannerProps {
  agentId: string
}

export function QuarantineBanner({ agentId }: QuarantineBannerProps): React.JSX.Element | null {
  const { data: agent, refetch } = useApiQuery(() => getAgent(agentId), [agentId])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [released, setReleased] = useState(false)

  const handleRelease = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await releaseAgent(agentId, true)
      setReleased(true)
      void refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to release agent")
    } finally {
      setBusy(false)
    }
  }, [agentId, refetch])

  // Hide banner if not quarantined or if just released
  if (!agent || agent.status !== "QUARANTINED" || released) {
    return null
  }

  return (
    <div className="flex items-center justify-between border-b border-red-200 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-900/20">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-lg text-red-500 dark:text-red-400">
          shield
        </span>
        <div>
          <span className="text-sm font-semibold text-red-700 dark:text-red-300">
            Agent Quarantined
          </span>
          <p className="text-xs text-red-600 dark:text-red-400">
            This agent has been quarantined and cannot process messages. Release it to resume
            operation.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-red-500">{error}</span>}
        <button
          type="button"
          onClick={() => void handleRelease()}
          disabled={busy}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">lock_open</span>
          {busy ? "Releasing..." : "Release"}
        </button>
      </div>
    </div>
  )
}
