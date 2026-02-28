"use client"

import { useCallback, useMemo, useState } from "react"

import type { ActiveFilters } from "@/components/memory/memory-search"
import { useApiQuery } from "@/hooks/use-api"
import type { MemoryRecord } from "@/lib/api-client"
import { searchMemory, syncMemory } from "@/lib/api-client"

const DEFAULT_AGENT_ID = "default"

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

export function useMemoryExplorer() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>({
    type: "ALL",
    importance: "ALL",
    scoreThreshold: 0,
    timeRange: "ALL",
  })

  // Skip the API call when the query is empty to avoid sending a wildcard
  // that the backend would try to parse as a UUID (bug #216).
  const {
    data,
    isLoading,
    error: rawError,
    errorCode: rawErrorCode,
    refetch,
  } = useApiQuery(
    () =>
      searchQuery.trim()
        ? searchMemory({ agentId: DEFAULT_AGENT_ID, query: searchQuery.trim(), limit: 50 })
        : Promise.resolve({ results: [] as MemoryRecord[] }),
    [searchQuery],
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
    await syncMemory(DEFAULT_AGENT_ID)
    if (searchQuery.trim()) {
      await refetch()
    }
  }, [searchQuery, refetch])

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
    agentId: DEFAULT_AGENT_ID,
  }
}
