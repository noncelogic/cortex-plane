"use client"

import { useCallback, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { syncMemory } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncStatusProps {
  agentId: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SyncStatus({ agentId }: SyncStatusProps): React.JSX.Element {
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const [stats, setStats] = useState<{
    upserted: number
    deleted: number
    unchanged: number
  } | null>(null)
  const { isLoading, error, execute } = useApi(
    (id: unknown) => syncMemory(id as string),
    `sync:${agentId}`,
  )

  const handleSync = useCallback(async () => {
    const result = await execute(agentId)
    if (result) {
      setLastSync(new Date())
      setStats(result.stats)
    }
  }, [execute, agentId])

  return (
    <div className="flex items-center gap-3">
      {/* Status indicator */}
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
        <span
          className={`inline-block size-1.5 rounded-full ${
            isLoading ? "animate-pulse bg-yellow-400" : lastSync ? "bg-emerald-500" : "bg-slate-600"
          }`}
        />
        {isLoading ? "Syncing..." : lastSync ? `Synced ${formatTime(lastSync)}` : "Not synced"}
      </span>

      {/* Stats */}
      {stats && !isLoading && (
        <span className="hidden text-xs text-slate-500 sm:inline">
          {stats.upserted > 0 && <span className="text-emerald-400">+{stats.upserted}</span>}
          {stats.deleted > 0 && <span className="ml-1 text-red-400">-{stats.deleted}</span>}
          {stats.upserted === 0 && stats.deleted === 0 && (
            <span className="text-slate-500">{stats.unchanged} unchanged</span>
          )}
        </span>
      )}

      {/* Error */}
      {error && (
        <span className="text-xs text-red-400" title={error}>
          Sync failed
        </span>
      )}

      {/* Sync button */}
      <button
        type="button"
        onClick={handleSync}
        disabled={isLoading}
        className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
      >
        <span className={`material-symbols-outlined text-sm ${isLoading ? "animate-spin" : ""}`}>
          sync
        </span>
        {isLoading ? "Syncing" : "Sync"}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(date: Date): string {
  const diff = Date.now() - date.getTime()
  if (diff < 60_000) return "just now"
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}
