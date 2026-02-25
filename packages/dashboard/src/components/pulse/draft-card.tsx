"use client"

import type { ContentPiece } from "@/lib/api-client"
import { relativeTime } from "@/lib/format"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContentCardProps {
  piece: ContentPiece
  onEdit?: (id: string) => void
  onPublish?: (id: string) => void
  onArchive?: (id: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const typeColors: Record<string, string> = {
  blog: "bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300",
  social: "bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-300",
  newsletter: "bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300",
  report: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300",
}

const statusIndicators: Record<string, { color: string; label: string }> = {
  DRAFT: { color: "bg-slate-400", label: "Draft" },
  IN_REVIEW: { color: "bg-amber-400", label: "In Review" },
  QUEUED: { color: "bg-blue-400", label: "Queued" },
  PUBLISHED: { color: "bg-emerald-400", label: "Published" },
}

function getInitials(name: string): string {
  return name
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContentCard({
  piece,
  onEdit,
  onPublish,
  onArchive,
}: ContentCardProps): React.JSX.Element {
  const status = statusIndicators[piece.status] ?? statusIndicators.DRAFT!
  const typeClass = typeColors[piece.type] ?? typeColors.blog!

  return (
    <div className="group rounded-xl border border-slate-200 bg-white shadow-sm transition-all duration-200 hover:border-primary/30 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/50 dark:hover:border-primary/30">
      <div className="flex gap-3 p-4">
        {/* Drag handle */}
        <div className="flex flex-col items-center justify-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-40">
          <div className="flex gap-0.5">
            <div className="size-1 rounded-full bg-slate-400" />
            <div className="size-1 rounded-full bg-slate-400" />
          </div>
          <div className="flex gap-0.5">
            <div className="size-1 rounded-full bg-slate-400" />
            <div className="size-1 rounded-full bg-slate-400" />
          </div>
          <div className="flex gap-0.5">
            <div className="size-1 rounded-full bg-slate-400" />
            <div className="size-1 rounded-full bg-slate-400" />
          </div>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Title + status */}
          <div className="mb-1 flex items-start justify-between gap-2">
            <h3 className="truncate text-sm font-bold text-text-main dark:text-white">
              {piece.title}
            </h3>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              <div className={`size-2 rounded-full ${status.color}`} />
              <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                {status.label}
              </span>
            </div>
          </div>

          {/* Preview snippet */}
          <p className="mb-2 line-clamp-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {piece.body}
          </p>

          {/* Agent + type tag + word count */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <div className="flex size-5 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
                <span className="text-[8px] font-bold text-primary dark:text-blue-300">
                  {getInitials(piece.agentName)}
                </span>
              </div>
              <span className="text-xs text-slate-600 dark:text-slate-300">{piece.agentName}</span>
            </div>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${typeClass}`}>
              {piece.type}
            </span>
            <span className="text-[10px] text-slate-400">
              {piece.wordCount.toLocaleString()} words
            </span>
            <span className="text-[10px] text-slate-400">{relativeTime(piece.createdAt)}</span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={() => onEdit?.(piece.id)}
              className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-primary dark:hover:bg-slate-800"
              title="Edit"
            >
              <span className="material-symbols-outlined text-lg">edit</span>
            </button>
            {piece.status !== "PUBLISHED" && (
              <button
                type="button"
                onClick={() => onPublish?.(piece.id)}
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-900/20 dark:hover:text-emerald-400"
                title="Publish"
              >
                <span className="material-symbols-outlined text-lg">send</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onArchive?.(piece.id)}
              className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20 dark:hover:text-red-400"
              title="Archive"
            >
              <span className="material-symbols-outlined text-lg">archive</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
