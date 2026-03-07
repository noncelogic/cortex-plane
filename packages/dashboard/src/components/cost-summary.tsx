"use client"

import type { AgentCostResponse } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUsd(value: number): string {
  if (value === 0) return "$0.00"
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CostSummaryProps {
  data: AgentCostResponse | null
  isLoading: boolean
  /** Title override (default: "Cost Summary") */
  title?: string
}

export function CostSummary({
  data,
  isLoading,
  title = "Cost Summary",
}: CostSummaryProps): React.JSX.Element {
  if (isLoading || !data) {
    return (
      <div className="rounded-xl border border-surface-border bg-surface-light p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="material-symbols-outlined text-lg text-primary">payments</span>
          <h3 className="text-sm font-bold text-text-main">{title}</h3>
        </div>
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse">
              <div className="mb-1 h-3 w-16 rounded bg-surface-border" />
              <div className="h-6 w-20 rounded bg-surface-border" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const { summary, breakdown } = data

  return (
    <div className="rounded-xl border border-surface-border bg-surface-light p-4">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2">
        <span className="material-symbols-outlined text-lg text-primary">payments</span>
        <h3 className="text-sm font-bold text-text-main">{title}</h3>
      </div>

      {/* Summary cards */}
      <div className="mb-4 grid grid-cols-3 gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase text-text-muted">Total Cost</p>
          <p className="text-lg font-bold text-text-main">{formatUsd(summary.totalUsd)}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase text-text-muted">Tokens In</p>
          <p className="text-lg font-bold text-text-main">{formatTokens(summary.tokensIn)}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase text-text-muted">Tokens Out</p>
          <p className="text-lg font-bold text-text-main">{formatTokens(summary.tokensOut)}</p>
        </div>
      </div>

      {/* Breakdown */}
      {breakdown.length > 0 && (
        <div>
          <h4 className="mb-2 text-[10px] font-bold uppercase text-text-muted">Breakdown</h4>
          <div className="space-y-1.5">
            {breakdown.map((entry, i) => {
              // entry can have a `model`, `session`, or `day` key
              const rec = entry as Record<string, unknown>
              const rawLabel = rec.model ?? rec.session ?? rec.day
              const label = typeof rawLabel === "string" ? rawLabel : `Segment ${i + 1}`
              const pct = summary.totalUsd > 0 ? (entry.costUsd / summary.totalUsd) * 100 : 0
              return (
                <div key={i} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate font-mono text-text-main">{label}</span>
                      <span className="font-bold text-text-main">{formatUsd(entry.costUsd)}</span>
                    </div>
                    <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-border">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{ width: `${Math.max(pct, 1)}%` }}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
