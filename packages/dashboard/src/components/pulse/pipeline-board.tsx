"use client"

import { useMemo, useState } from "react"

import type { ContentPiece, ContentStatus } from "@/lib/api-client"

import { ContentCard } from "./draft-card"

// ---------------------------------------------------------------------------
// Column configuration
// ---------------------------------------------------------------------------

interface ColumnDef {
  status: ContentStatus
  label: string
  icon: string
  emptyIcon: string
  emptyText: string
  borderColor: string
  badgeBg: string
  badgeText: string
}

const COLUMNS: ColumnDef[] = [
  {
    status: "DRAFT",
    label: "Draft",
    icon: "edit_note",
    emptyIcon: "draft",
    emptyText: "No drafts yet",
    borderColor: "border-t-slate-400",
    badgeBg: "bg-secondary",
    badgeText: "text-text-muted",
  },
  {
    status: "IN_REVIEW",
    label: "In Review",
    icon: "rate_review",
    emptyIcon: "preview",
    emptyText: "Nothing in review",
    borderColor: "border-t-amber-400",
    badgeBg: "bg-amber-500/10",
    badgeText: "text-amber-500",
  },
  {
    status: "QUEUED",
    label: "Queued",
    icon: "schedule_send",
    emptyIcon: "hourglass_empty",
    emptyText: "Queue is empty",
    borderColor: "border-t-blue-400",
    badgeBg: "bg-blue-500/10",
    badgeText: "text-blue-500",
  },
  {
    status: "PUBLISHED",
    label: "Published",
    icon: "task_alt",
    emptyIcon: "check_circle",
    emptyText: "No published content",
    borderColor: "border-t-emerald-400",
    badgeBg: "bg-emerald-500/10",
    badgeText: "text-emerald-500",
  },
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PipelineBoardProps {
  pieces: ContentPiece[]
  onEdit?: (id: string) => void
  onPublish?: (id: string) => void
  onArchive?: (id: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PipelineBoard({
  pieces,
  onEdit,
  onPublish,
  onArchive,
}: PipelineBoardProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<ContentStatus>("DRAFT")

  // Group pieces by status
  const grouped = useMemo(() => {
    const map: Record<ContentStatus, ContentPiece[]> = {
      DRAFT: [],
      IN_REVIEW: [],
      QUEUED: [],
      PUBLISHED: [],
    }
    for (const p of pieces) {
      map[p.status]?.push(p)
    }
    return map
  }, [pieces])

  return (
    <>
      {/* Mobile: Tab switcher */}
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg bg-secondary p-1 lg:hidden">
        {COLUMNS.map((col) => {
          const count = grouped[col.status]?.length ?? 0
          return (
            <button
              key={col.status}
              type="button"
              onClick={() => setActiveTab(col.status)}
              className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-2 text-xs font-bold transition-all ${
                activeTab === col.status
                  ? "bg-surface-light text-text-main shadow-sm"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              {col.label}
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${col.badgeBg} ${col.badgeText}`}
              >
                {count}
              </span>
            </button>
          )
        })}
      </div>

      {/* Mobile: Active column */}
      <div className="lg:hidden">
        {COLUMNS.filter((col) => col.status === activeTab).map((col) => (
          <div key={col.status} className="space-y-3">
            {(grouped[col.status]?.length ?? 0) === 0 ? (
              <div className="rounded-xl border border-dashed border-surface-border p-8 text-center">
                <span className="material-symbols-outlined mb-2 text-3xl text-slate-400">
                  {col.emptyIcon}
                </span>
                <p className="text-sm text-slate-500">{col.emptyText}</p>
              </div>
            ) : (
              grouped[col.status]!.map((piece) => (
                <ContentCard
                  key={piece.id}
                  piece={piece}
                  onEdit={onEdit}
                  onPublish={onPublish}
                  onArchive={onArchive}
                />
              ))
            )}
          </div>
        ))}
      </div>

      {/* Desktop: 4-column kanban */}
      <div className="hidden gap-4 lg:grid lg:grid-cols-4">
        {COLUMNS.map((col) => {
          const items = grouped[col.status] ?? []
          return (
            <div key={col.status} className="flex flex-col">
              {/* Column header */}
              <div
                className={`mb-3 flex items-center justify-between rounded-t-lg border-t-2 ${col.borderColor} px-1 pt-3`}
              >
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg text-slate-500">
                    {col.icon}
                  </span>
                  <h3 className="text-sm font-bold text-text-main">{col.label}</h3>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-bold ${col.badgeBg} ${col.badgeText}`}
                >
                  {items.length}
                </span>
              </div>

              {/* Column body */}
              <div className="flex-1 space-y-3 overflow-y-auto" style={{ maxHeight: "calc(100vh - 340px)" }}>
                {items.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-surface-border p-6 text-center">
                    <span className="material-symbols-outlined mb-2 text-2xl text-slate-400">
                      {col.emptyIcon}
                    </span>
                    <p className="text-xs text-slate-500">{col.emptyText}</p>
                  </div>
                ) : (
                  items.map((piece) => (
                    <ContentCard
                      key={piece.id}
                      piece={piece}
                      onEdit={onEdit}
                      onPublish={onPublish}
                      onArchive={onArchive}
                    />
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
