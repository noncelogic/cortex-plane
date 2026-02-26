"use client"

import { DocumentViewer } from "@/components/memory/document-viewer"
import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { MemoryResults } from "@/components/memory/memory-results"
import { MemorySearch } from "@/components/memory/memory-search"
import { SyncStatus } from "@/components/memory/sync-status"
import { Skeleton } from "@/components/layout/skeleton"
import { useMemoryExplorer } from "@/hooks/use-memory-explorer"

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MemoryPage(): React.JSX.Element {
  const {
    filteredRecords,
    selectedId,
    setSelectedId,
    selectedRecord,
    relatedRecords,
    setSearchQuery,
    handleSearch,
    handleSelectResult,
    isLoading,
    error,
    errorCode,
    agentId,
    allRecords,
  } = useMemoryExplorer()

  // Loading skeleton
  if (isLoading && allRecords.length === 0) {
    return (
      <div className="space-y-8">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-[28px] text-primary">memory</span>
          <h1 className="font-display text-2xl font-bold tracking-tight text-text-main dark:text-white">
            Memory Explorer
          </h1>
        </div>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-extrabold tracking-tight text-text-main dark:text-slate-100">
            Memory Explorer
          </h1>
          <p className="max-w-lg text-slate-500 dark:text-slate-400">
            Search and browse agent memory records — facts, preferences, events, and system rules.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SyncStatus agentId={agentId} />
          <button
            type="button"
            onClick={() => {
              setSearchQuery("")
              setSelectedId(null)
            }}
            className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-4 py-2 text-sm font-bold text-primary transition-all hover:bg-primary/20"
          >
            <span className="material-symbols-outlined text-lg">add</span>
            New Query
          </button>
        </div>
      </div>

      {/* Search bar */}
      <MemorySearch onSearch={handleSearch} isLoading={isLoading} />

      {/* Error */}
      {error && <ApiErrorBanner error={error} errorCode={errorCode} />}

      {/* Empty state */}
      {!isLoading && !error && allRecords.length === 0 ? (
        <EmptyState
          icon="memory"
          title="No memory records"
          description="Memory records will appear here once agents begin extracting and storing knowledge."
        />
      ) : (
        /* Split view: Results (left) | Document Viewer (right) */
        <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-slate-800 lg:flex-row">
          {/* Left: Results */}
          <div className="border-b border-slate-800 lg:border-b-0 lg:border-r">
            <MemoryResults
              results={filteredRecords}
              selectedId={selectedId}
              onSelect={handleSelectResult}
              isLoading={isLoading}
            />
          </div>

          {/* Right: Document Viewer */}
          <DocumentViewer
            record={selectedRecord}
            relatedRecords={relatedRecords}
            onSelectRelated={handleSelectResult}
          />
        </div>
      )}
    </div>
  )
}
