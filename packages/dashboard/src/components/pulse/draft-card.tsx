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
  blog: "bg-blue-500/10 text-blue-500",
  social: "bg-purple-500/10 text-purple-500",
  newsletter: "bg-amber-500/10 text-amber-500",
  report: "bg-emerald-500/10 text-emerald-500",
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
    <div className="group rounded-xl border border-surface-border bg-surface-light shadow-sm transition-all duration-200 hover:border-primary/30 hover:shadow-md">
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
            <h3 className="truncate text-sm font-bold text-text-main">{piece.title}</h3>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              <div className={`size-2 rounded-full ${status.color}`} />
              <span className="text-[10px] font-medium text-text-muted">{status.label}</span>
            </div>
          </div>

          {/* Preview snippet */}
          <p className="mb-2 line-clamp-2 text-xs leading-relaxed text-text-muted">{piece.body}</p>

          {/* Agent + type tag + word count */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <div className="flex size-5 items-center justify-center rounded-full bg-blue-500/10">
                <span className="text-[8px] font-bold text-primary">
                  {getInitials(piece.agentName)}
                </span>
              </div>
              <span className="text-xs text-text-muted">{piece.agentName}</span>
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
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-secondary hover:text-primary"
              title="Edit"
            >
              <span className="material-symbols-outlined text-lg">edit</span>
            </button>
            {piece.status !== "PUBLISHED" && (
              <button
                type="button"
                onClick={() => onPublish?.(piece.id)}
                className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-emerald-500/10 hover:text-emerald-500"
                title="Publish"
              >
                <span className="material-symbols-outlined text-lg">send</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onArchive?.(piece.id)}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
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
