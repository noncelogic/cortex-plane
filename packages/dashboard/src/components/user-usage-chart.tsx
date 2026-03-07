"use client"

import { useCallback, useState } from "react"

import { Panel } from "@/components/ui/panel"
import { useApiQuery } from "@/hooks/use-api"
import type { UserUsageLedger } from "@/lib/api/users"
import { getUserUsage } from "@/lib/api/users"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TimeRange = "24h" | "7d" | "30d"

interface UserUsageChartProps {
  userId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aggregateUsage(entries: UserUsageLedger[]) {
  let totalMessages = 0
  let totalTokensIn = 0
  let totalTokensOut = 0
  let totalCost = 0

  for (const entry of entries) {
    totalMessages += entry.messages_sent
    totalTokensIn += entry.tokens_in
    totalTokensOut += entry.tokens_out
    totalCost += parseFloat(entry.cost_usd)
  }

  return { totalMessages, totalTokensIn, totalTokensOut, totalCost }
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const RANGE_LABELS: Record<TimeRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
}

export function UserUsageChart({ userId }: UserUsageChartProps) {
  const [range, setRange] = useState<TimeRange>("7d")

  const fetchUsage = useCallback(() => getUserUsage(userId, { range }), [userId, range])
  const { data, isLoading, error } = useApiQuery(fetchUsage, [userId, range])

  const usage = data?.usage ?? []
  const stats = aggregateUsage(usage)

  return (
    <Panel className="p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-sm font-bold text-text-main">Usage</h3>
        <div className="flex gap-1 rounded-lg bg-secondary p-0.5">
          {(["24h", "7d", "30d"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                range === r
                  ? "bg-surface-light text-text-main shadow-sm"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="mt-4 flex items-center justify-center py-8">
          <span className="text-sm text-text-muted">Loading usage data…</span>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg bg-danger/10 px-4 py-3 text-sm text-danger">
          Failed to load usage data
        </div>
      )}

      {!isLoading && !error && (
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Messages" value={String(stats.totalMessages)} icon="chat" />
          <StatCard label="Tokens in" value={formatTokens(stats.totalTokensIn)} icon="input" />
          <StatCard label="Tokens out" value={formatTokens(stats.totalTokensOut)} icon="output" />
          <StatCard label="Cost" value={`$${stats.totalCost.toFixed(2)}`} icon="payments" />
        </div>
      )}

      {!isLoading && !error && usage.length === 0 && (
        <p className="mt-2 text-center text-xs text-text-muted">
          No usage in the last {RANGE_LABELS[range]}
        </p>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Internal stat card
// ---------------------------------------------------------------------------

function StatCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="rounded-lg bg-secondary px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-text-muted">
        <span className="material-symbols-outlined text-sm">{icon}</span>
        {label}
      </div>
      <p className="mt-1 font-display text-lg font-bold text-text-main">{value}</p>
    </div>
  )
}
