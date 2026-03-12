"use client"

import { useCallback, useMemo, useState } from "react"

import type { ActiveFilters } from "@/components/memory/memory-search"
import { useApiQuery } from "@/hooks/use-api"
import type { MemoryRecord } from "@/lib/api-client"
import { listAgents, searchMemory, syncMemory } from "@/lib/api-client"

function applyFilters(
  records: MemoryRecord[],
  query: string,
  filters: ActiveFilters,
): MemoryRecord[] {
  return records.filter((r) => {
    if (query) {
      const q = query.toLowerCase()
      const matches =
        r.content.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)) ||
        r.source.toLowerCase().includes(q)
      if (!matches) return false
    }

    if (filters.type !== "ALL" && r.type !== filters.type) return false

    if (filters.importance !== "ALL") {
      if (filters.importance === "high" && r.importance < 4) return false
      if (filters.importance === "medium" && r.importance !== 3) return false
      if (filters.importance === "low" && r.importance > 2) return false
    }

    if (filters.scoreThreshold > 0 && r.score !== undefined) {
      if (r.score * 100 < filters.scoreThreshold) return false
    }

    if (filters.timeRange !== "ALL") {
      const now = Date.now()
      const ranges: Record<string, number> = {
        "24h": 86_400_000,
        "7d": 7 * 86_400_000,
        "30d": 30 * 86_400_000,
        "90d": 90 * 86_400_000,
      }
      const maxAge = ranges[filters.timeRange]
      if (maxAge && now - r.createdAt > maxAge) return false
    }

    return true
  })
}

export function useMemoryExplorer(explicitAgentId?: string) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [syncError, setSyncError] = useState<string | null>(null)
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>({
    type: "ALL",
    importance: "ALL",
    scoreThreshold: 0,
    timeRange: "ALL",
  })

  // Fetch agents to get a real agent ID for memory search (skipped when explicit ID provided)
  const { data: agentData } = useApiQuery(
    () => (explicitAgentId ? Promise.resolve(null) : listAgents({ limit: 1 })),
    [explicitAgentId],
  )
  const agentId = explicitAgentId ?? agentData?.agents?.[0]?.id ?? null

  // Skip the API call when the query is empty or no agent is available
  const {
    data,
    isLoading,
    error: rawError,
    errorCode: rawErrorCode,
    refetch,
  } = useApiQuery(
    () =>
      searchQuery.trim() && agentId
        ? searchMemory({ agent_id: agentId, query: searchQuery.trim(), limit: 50 })
        : Promise.resolve({ results: [] as MemoryRecord[] }),
    [searchQuery, agentId],
  )

  // A 404 means the /memory/search route isn't deployed — not a connection failure.
  const error = rawErrorCode === "NOT_FOUND" ? null : rawError
  const errorCode = rawErrorCode === "NOT_FOUND" ? null : rawErrorCode

  const allRecords: MemoryRecord[] = useMemo(() => {
    if (data?.results) return data.results
    return []
  }, [data])

  const filteredRecords = useMemo(
    () => applyFilters(allRecords, searchQuery, activeFilters),
    [allRecords, searchQuery, activeFilters],
  )

  const selectedRecord = useMemo(
    () => allRecords.find((r) => r.id === selectedId) ?? null,
    [allRecords, selectedId],
  )

  const relatedRecords = useMemo(() => {
    if (!selectedRecord) return []
    return allRecords.filter((r) => r.id !== selectedId).slice(0, 4)
  }, [allRecords, selectedId, selectedRecord])

  const handleSearch = useCallback((query: string, filters: ActiveFilters) => {
    setSearchQuery(query)
    setActiveFilters(filters)
  }, [])

  const handleSelectResult = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  const handleSync = useCallback(async () => {
    if (!agentId) return
    setSyncError(null)
    try {
      await syncMemory(agentId)
      if (searchQuery.trim()) {
        await refetch()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to sync memory"
      setSyncError(msg)
    }
  }, [agentId, searchQuery, refetch])

  return {
    allRecords,
    filteredRecords,
    selectedId,
    setSelectedId,
    selectedRecord,
    relatedRecords,
    searchQuery,
    setSearchQuery,
    activeFilters,
    setActiveFilters,
    handleSearch,
    handleSelectResult,
    handleSync,
    isLoading,
    error,
    errorCode: errorCode,
    syncError,
    agentId: agentId ?? "",
    refetch,
  }
}
