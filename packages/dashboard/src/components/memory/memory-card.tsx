import type { MemoryRecord } from "@/lib/api-client"

interface MemoryCardProps {
  record: MemoryRecord
}

const TYPE_CONFIG: Record<MemoryRecord["type"], { icon: string; color: string; bg: string }> = {
  fact: { icon: "lightbulb", color: "text-amber-400", bg: "bg-amber-400/10" },
  preference: { icon: "tune", color: "text-blue-400", bg: "bg-blue-400/10" },
  event: { icon: "event", color: "text-emerald-400", bg: "bg-emerald-400/10" },
  system_rule: { icon: "gavel", color: "text-purple-400", bg: "bg-purple-400/10" },
}

export function MemoryCard({ record }: MemoryCardProps): React.JSX.Element {
  const config = TYPE_CONFIG[record.type]

  return (
    <div className="rounded-lg border border-slate-800 bg-surface-dark p-4">
      <div className="mb-2 flex items-center gap-2">
        <div className={`flex size-8 items-center justify-center rounded-lg ${config.bg}`}>
          <span className={`material-symbols-outlined text-lg ${config.color}`}>{config.icon}</span>
        </div>
        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
          {record.type.replace("_", " ")}
        </span>
        <span className="text-xs text-slate-500">importance: {record.importance}</span>
        {record.score !== undefined && (
          <span className={`ml-auto rounded px-1.5 py-0.5 text-xs font-medium ${
            record.score >= 0.85
              ? "bg-primary/10 font-bold text-primary"
              : "bg-slate-800 text-slate-400"
          }`}>
            {Math.round(record.score * 100)}%
          </span>
        )}
      </div>
      <p className="line-clamp-3 text-sm text-slate-200">{record.content}</p>
      {record.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {record.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
