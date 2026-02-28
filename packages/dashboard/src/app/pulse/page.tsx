"use client"

import { useCallback, useEffect, useState } from "react"

import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { ContentFilters } from "@/components/pulse/content-filters"
import { PipelineBoard } from "@/components/pulse/pipeline-board"
import { PipelineStats } from "@/components/pulse/pipeline-stats"
import { PublishAction } from "@/components/pulse/publish-action"
import { usePulsePipeline } from "@/hooks/use-pulse-pipeline"
import type { ContentPiece } from "@/lib/api-client"
import { relativeTime } from "@/lib/format"

// ---------------------------------------------------------------------------
// Archive confirmation dialog
// ---------------------------------------------------------------------------

function ArchiveConfirmDialog({
  piece,
  onConfirm,
  onCancel,
}: {
  piece: ContentPiece
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState("")

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onCancel])

  const handleConfirm = (): void => {
    setSubmitting(true)
    try {
      onConfirm()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to archive")
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
        role="presentation"
      />
      <div className="relative w-full max-w-md rounded-xl border border-surface-border bg-surface-light p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-red-500/10">
            <span className="material-symbols-outlined text-xl text-red-500">archive</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-text-main">Archive Content</h3>
            <p className="text-sm text-text-muted">
              This will remove the content from the pipeline.
            </p>
          </div>
        </div>

        <p className="mb-4 truncate text-sm text-text-muted">&ldquo;{piece.title}&rdquo;</p>

        {errorMsg && (
          <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {errorMsg}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-text-muted transition-colors hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-6 py-2 text-sm font-bold text-white shadow-md shadow-red-600/20 transition-all hover:bg-red-500 active:scale-95 disabled:opacity-50"
          >
            {submitting ? (
              <>
                <span className="material-symbols-outlined animate-spin text-lg">
                  progress_activity
                </span>
                Archiving...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-lg">archive</span>
                Archive
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Content detail drawer
// ---------------------------------------------------------------------------

const statusIndicators: Record<string, { color: string; label: string }> = {
  DRAFT: { color: "bg-slate-400", label: "Draft" },
  IN_REVIEW: { color: "bg-amber-400", label: "In Review" },
  QUEUED: { color: "bg-blue-400", label: "Queued" },
  PUBLISHED: { color: "bg-emerald-400", label: "Published" },
}

const typeColors: Record<string, string> = {
  blog: "bg-blue-500/10 text-blue-500",
  social: "bg-purple-500/10 text-purple-500",
  newsletter: "bg-amber-500/10 text-amber-500",
  report: "bg-emerald-500/10 text-emerald-500",
}

function ContentDetailDrawer({
  piece,
  onClose,
  onPublish,
  onArchive,
}: {
  piece: ContentPiece
  onClose: () => void
  onPublish: (id: string) => void
  onArchive: (id: string) => void
}): React.JSX.Element {
  const status = statusIndicators[piece.status] ?? statusIndicators.DRAFT!
  const typeClass = typeColors[piece.type] ?? typeColors.blog!

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-40 flex">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm lg:bg-transparent lg:backdrop-blur-none"
        onClick={onClose}
        role="presentation"
      />
      <div className="relative ml-auto flex h-full w-full max-w-2xl flex-col border-l border-surface-border bg-surface-light shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-secondary hover:text-text-main"
            >
              <span className="material-symbols-outlined text-xl">close</span>
            </button>
            <h2 className="text-lg font-bold text-text-main">Content Detail</h2>
          </div>
          <div className="flex items-center gap-2">
            {piece.status !== "PUBLISHED" && (
              <button
                type="button"
                onClick={() => onPublish(piece.id)}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white shadow-md shadow-emerald-600/20 transition-all hover:bg-emerald-500 active:scale-95"
              >
                <span className="material-symbols-outlined text-lg">send</span>
                Publish
              </button>
            )}
            <button
              type="button"
              onClick={() => onArchive(piece.id)}
              className="flex items-center gap-1.5 rounded-lg border border-surface-border px-4 py-2 text-sm font-semibold text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
            >
              <span className="material-symbols-outlined text-lg">archive</span>
              Archive
            </button>
          </div>
        </div>

        {/* Content body */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Title */}
          <h1 className="mb-4 text-2xl font-bold text-text-main">{piece.title}</h1>

          {/* Metadata */}
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div className={`size-2 rounded-full ${status.color}`} />
              <span className="text-sm font-medium text-text-muted">{status.label}</span>
            </div>
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${typeClass}`}>
              {piece.type}
            </span>
            <span className="text-sm text-text-muted">
              {piece.word_count.toLocaleString()} words
            </span>
          </div>

          {/* Info grid */}
          <div className="mb-6 grid grid-cols-2 gap-4 rounded-xl border border-surface-border bg-secondary p-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                Agent
              </p>
              <p className="text-sm font-medium text-text-main">{piece.agent_name}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                Created
              </p>
              <p className="text-sm font-medium text-text-main">{relativeTime(piece.created_at)}</p>
            </div>
            {piece.published_at && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                  Published
                </p>
                <p className="text-sm font-medium text-text-main">
                  {relativeTime(piece.published_at)}
                </p>
              </div>
            )}
            {piece.channel && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                  Channel
                </p>
                <p className="text-sm font-medium text-text-main">{piece.channel}</p>
              </div>
            )}
          </div>

          {/* Full body */}
          <div className="prose prose-sm max-w-none text-text-main dark:prose-invert">
            <div className="whitespace-pre-wrap rounded-xl border border-surface-border bg-bg-light p-5 text-sm leading-relaxed">
              {piece.body}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PulsePage(): React.JSX.Element {
  const {
    filteredPieces,
    stats,
    agentNames,
    filters,
    setFilters,
    setPublishingId,
    publishingPiece,
    handlePublish,
    archivingPiece,
    setArchivingId,
    handleArchive,
    selectedPiece,
    setSelectedId,
    error,
    errorCode,
    isLoading,
    pieces,
  } = usePulsePipeline()

  const onCardClick = useCallback(
    (id: string) => {
      setSelectedId(id)
    },
    [setSelectedId],
  )

  const onCardPublish = useCallback(
    (id: string) => {
      setPublishingId(id)
    },
    [setPublishingId],
  )

  const onCardArchive = useCallback(
    (id: string) => {
      setArchivingId(id)
    },
    [setArchivingId],
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <span className="material-symbols-outlined text-lg">home</span>
            <span>/</span>
            <span className="font-medium text-text-main dark:text-white">AI Pulse</span>
          </div>
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-text-main dark:text-slate-100">
            AI Pulse
          </h1>
          <p className="max-w-lg text-slate-500 dark:text-slate-400">
            Content pipeline powered by your AI agents. Review, approve, and publish across
            channels.
          </p>
        </div>
      </div>

      {/* Stats bar */}
      <PipelineStats stats={stats} />

      {/* Filters */}
      <ContentFilters
        filters={filters}
        onChange={setFilters}
        agentNames={agentNames}
        totalCount={filteredPieces.length}
      />

      {/* Error */}
      {error && <ApiErrorBanner error={error} errorCode={errorCode} />}

      {/* Empty state */}
      {!isLoading && !error && pieces.length === 0 ? (
        <EmptyState
          icon="hub"
          title="No content yet"
          description="Content pieces will appear here as agents generate drafts, newsletters, and reports."
        />
      ) : null}

      {/* Kanban board */}
      {pieces.length > 0 && (
        <PipelineBoard
          pieces={filteredPieces}
          onEdit={onCardClick}
          onPublish={onCardPublish}
          onArchive={onCardArchive}
        />
      )}

      {/* Publish dialog */}
      {publishingPiece && (
        <PublishAction
          contentId={publishingPiece.id}
          contentTitle={publishingPiece.title}
          onPublish={handlePublish}
          onCancel={() => setPublishingId(null)}
        />
      )}

      {/* Archive confirmation dialog */}
      {archivingPiece && (
        <ArchiveConfirmDialog
          piece={archivingPiece}
          onConfirm={() => void handleArchive(archivingPiece.id)}
          onCancel={() => setArchivingId(null)}
        />
      )}

      {/* Content detail drawer */}
      {selectedPiece && (
        <ContentDetailDrawer
          piece={selectedPiece}
          onClose={() => setSelectedId(null)}
          onPublish={(id) => {
            setSelectedId(null)
            setPublishingId(id)
          }}
          onArchive={(id) => {
            setSelectedId(null)
            setArchivingId(id)
          }}
        />
      )}
    </div>
  )
}
