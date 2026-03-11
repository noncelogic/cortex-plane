"use client"

import Link from "next/link"
import { use } from "react"

import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { Skeleton } from "@/components/layout/skeleton"
import { DocumentViewer } from "@/components/memory/document-viewer"
import { MemoryResults } from "@/components/memory/memory-results"
import { MemorySearch } from "@/components/memory/memory-search"
import { SyncStatus } from "@/components/memory/sync-status"
import { useApiQuery } from "@/hooks/use-api"
import { useMemoryExplorer } from "@/hooks/use-memory-explorer"
import { getAgent } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface AgentMemoryPageProps {
  params: Promise<{ agentId: string }>
}

export default function AgentMemoryPage({ params }: AgentMemoryPageProps): React.JSX.Element {
  const { agentId } = use(params)
  const { data: agent } = useApiQuery(() => getAgent(agentId), [agentId])

  const agentName = agent?.name ?? agentId

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
    allRecords,
    syncError,
  } = useMemoryExplorer(agentId)

  // Loading skeleton
  if (isLoading && allRecords.length === 0) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/agents" className="text-slate-400 transition-colors hover:text-primary">
            Agents
          </Link>
          <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
          <Link
            href={`/agents/${agentId}`}
            className="text-slate-400 transition-colors hover:text-primary"
          >
            {agentName}
          </Link>
          <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
          <span className="flex items-center gap-1.5 font-bold text-white">
            <span className="material-symbols-outlined text-sm text-primary">memory</span>
            Memory
          </span>
        </nav>
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/agents" className="text-slate-400 transition-colors hover:text-primary">
          Agents
        </Link>
        <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
        <Link
          href={`/agents/${agentId}`}
          className="text-slate-400 transition-colors hover:text-primary"
        >
          {agentName}
        </Link>
        <span className="material-symbols-outlined text-xs text-slate-600">chevron_right</span>
        <span className="flex items-center gap-1.5 font-bold text-white">
          <span className="material-symbols-outlined text-sm text-primary">memory</span>
          Memory
        </span>
      </nav>

      {/* Page header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
            <span className="material-symbols-outlined text-lg text-primary">memory</span>
          </div>
          <div>
            <h1 className="font-display text-xl font-black tracking-tight text-white lg:text-2xl">
              Memory
            </h1>
            <p className="text-xs text-slate-500">
              Search and browse memory records for this agent
            </p>
          </div>
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
      {syncError && <ApiErrorBanner error={syncError} errorCode={null} />}

      {/* Empty state */}
      {!isLoading && !error && allRecords.length === 0 ? (
        <EmptyState
          icon="memory"
          title="No memory records"
          description="Memory records will appear here once this agent begins extracting and storing knowledge."
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
