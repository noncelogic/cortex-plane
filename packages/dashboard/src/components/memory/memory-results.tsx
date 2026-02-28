"use client"

import type { MemoryRecord } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemoryResultsProps {
  results: MemoryRecord[]
  selectedId: string | null
  onSelect: (id: string) => void
  isLoading?: boolean
}

// ---------------------------------------------------------------------------
// Score badge color helpers
// ---------------------------------------------------------------------------

function scoreColor(score: number): string {
  if (score >= 85) return "bg-primary/10 text-primary font-bold"
  if (score >= 70) return "bg-slate-700 text-slate-300"
  return "bg-slate-800 text-slate-400"
}

function typeLabel(type: MemoryRecord["type"]): string {
  const labels: Record<MemoryRecord["type"], string> = {
    fact: "Fact",
    preference: "Preference",
    event: "Event",
    system_rule: "System Rule",
  }
  return labels[type]
}

function relativeTimeFromEpoch(epoch: number): string {
  const diff = Date.now() - epoch
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function ResultSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-3 p-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-lg bg-surface-dark p-3">
          <div className="mb-2 h-4 w-3/4 rounded bg-slate-700" />
          <div className="mb-2 h-3 w-full rounded bg-slate-700/60" />
          <div className="h-3 w-2/3 rounded bg-slate-700/40" />
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MemoryResults({
  results,
  selectedId,
  onSelect,
  isLoading,
}: MemoryResultsProps): React.JSX.Element {
  if (isLoading) {
    return (
      <div className="flex h-full w-full flex-col lg:w-[420px] lg:min-w-[420px]">
        <div className="sticky top-0 z-10 border-b border-slate-800 bg-bg-dark px-4 py-3">
          <div className="h-4 w-24 animate-pulse rounded bg-slate-700" />
        </div>
        <ResultSkeleton />
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col lg:w-[420px] lg:min-w-[420px]">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-bg-dark px-4 py-3">
        <span className="text-sm text-slate-400">
          <span className="font-bold text-slate-100">{results.length}</span>{" "}
          {results.length === 1 ? "result" : "results"}
        </span>
        <button
          type="button"
          onClick={() => {
            if (results.length === 0) return
            const header = "id,type,content,importance,confidence,source,createdAt\n"
            const rows = results.map((r) => {
              const escaped = r.content.replace(/"/g, '""')
              return `${r.id},${r.type},"${escaped}",${r.importance},${r.confidence},${r.source},${r.createdAt}`
            })
            const csv = header + rows.join("\n")
            const blob = new Blob([csv], { type: "text/csv" })
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = "memory-export.csv"
            a.click()
            URL.revokeObjectURL(url)
          }}
          className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-700 hover:text-slate-300"
        >
          <span className="material-symbols-outlined text-sm">download</span>
          Export CSV
        </button>
      </div>

      {/* Results list */}
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        {results.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <span className="material-symbols-outlined mb-3 text-4xl text-slate-600">
              neurology
            </span>
            <p className="text-sm font-medium text-slate-400">No memories found</p>
            <p className="mt-1 text-xs text-slate-500">
              Try a different query or adjust your filters.
            </p>
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {results.map((record) => {
              const isActive = record.id === selectedId
              const scorePercent =
                record.score !== undefined ? Math.round(record.score * 100) : null

              return (
                <button
                  key={record.id}
                  type="button"
                  onClick={() => onSelect(record.id)}
                  className={`relative w-full rounded-lg p-3 text-left transition-all ${
                    isActive
                      ? "border border-primary/40 bg-surface-dark"
                      : "border border-transparent hover:border-slate-700 hover:bg-surface-dark"
                  }`}
                >
                  {/* Active accent bar */}
                  {isActive && (
                    <div className="absolute left-0 top-1/2 h-8 w-1 -translate-y-1/2 rounded-r bg-primary" />
                  )}

                  {/* Title */}
                  <p className="line-clamp-1 text-sm font-medium text-slate-100">
                    {extractTitle(record.content)}
                  </p>

                  {/* Preview */}
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">
                    {record.content}
                  </p>

                  {/* Meta row */}
                  <div className="mt-2 flex items-center gap-2">
                    {scorePercent !== null && (
                      <span className={`rounded px-1.5 py-0.5 text-xs ${scoreColor(scorePercent)}`}>
                        {scorePercent}%
                      </span>
                    )}
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
                      {typeLabel(record.type)}
                    </span>
                    <span className="ml-auto text-xs text-slate-500">
                      {relativeTimeFromEpoch(record.createdAt)}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a title-like line from memory content. */
function extractTitle(content: string): string {
  const firstLine = content.split("\n")[0] ?? content
  // Remove markdown headings
  const cleaned = firstLine.replace(/^#+\s*/, "").trim()
  return cleaned.length > 60 ? cleaned.substring(0, 60) + "..." : cleaned
}
