"use client"

import type { MemoryRecord } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RelatedPanelProps {
  records: MemoryRecord[]
  onSelect?: (id: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TYPE_CONFIG: Record<MemoryRecord["type"], { icon: string; color: string; bg: string }> = {
  fact: { icon: "lightbulb", color: "text-amber-400", bg: "bg-amber-400/10" },
  preference: { icon: "tune", color: "text-blue-400", bg: "bg-blue-400/10" },
  event: { icon: "event", color: "text-emerald-400", bg: "bg-emerald-400/10" },
  system_rule: { icon: "gavel", color: "text-purple-400", bg: "bg-purple-400/10" },
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RelatedPanel({ records, onSelect }: RelatedPanelProps): React.JSX.Element {
  if (records.length === 0) return <></>

  return (
    <div className="p-6">
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
        Related Memories
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {records.map((record) => {
          const config = TYPE_CONFIG[record.type]
          const scorePercent = record.score !== undefined ? Math.round(record.score * 100) : null

          return (
            <button
              key={record.id}
              type="button"
              onClick={() => onSelect?.(record.id)}
              className="group rounded-xl border border-slate-800 p-4 text-left transition-all hover:border-primary/40"
            >
              <div className="flex items-start gap-3">
                {/* Icon */}
                <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${config.bg}`}>
                  <span className={`material-symbols-outlined text-xl ${config.color}`}>
                    {config.icon}
                  </span>
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-sm font-medium text-slate-200 group-hover:text-slate-100">
                    {extractTitle(record.content)}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">
                    {record.content}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
                      {typeLabel(record.type)}
                    </span>
                    {scorePercent !== null && (
                      <span className={`text-xs ${scorePercent >= 85 ? "font-bold text-primary" : "text-slate-500"}`}>
                        {scorePercent}%
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTitle(content: string): string {
  const firstLine = content.split("\n")[0] ?? content
  const cleaned = firstLine.replace(/^#+\s*/, "").trim()
  return cleaned.length > 50 ? cleaned.substring(0, 50) + "..." : cleaned
}
