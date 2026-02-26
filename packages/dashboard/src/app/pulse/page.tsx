"use client"

import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { ContentFilters } from "@/components/pulse/content-filters"
import { PipelineBoard } from "@/components/pulse/pipeline-board"
import { PipelineStats } from "@/components/pulse/pipeline-stats"
import { PublishAction } from "@/components/pulse/publish-action"
import { usePulsePipeline } from "@/hooks/use-pulse-pipeline"

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
    error,
    errorCode,
    isLoading,
    pieces,
  } = usePulsePipeline()

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
            Content pipeline powered by your AI agents. Review, approve, and publish across channels.
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
          onEdit={(id) => {
            // Edit action — future implementation
            console.log("Edit:", id)
          }}
          onPublish={setPublishingId}
          onArchive={(id) => {
            // Archive action — future implementation
            console.log("Archive:", id)
          }}
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
    </div>
  )
}
