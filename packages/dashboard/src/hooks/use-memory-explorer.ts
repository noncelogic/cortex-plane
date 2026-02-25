'use client'

import { useCallback, useMemo, useState } from "react"

import type { ActiveFilters } from "@/components/memory/memory-search"
import { useApiQuery } from "@/hooks/use-api"
import type { MemoryRecord } from "@/lib/api-client"
import { searchMemory, syncMemory } from "@/lib/api-client"
import { isMockEnabled } from "@/lib/mock"
import { generateMockMemories, MOCK_AGENT_ID } from "@/lib/mock/memory"

function applyFilters(records: MemoryRecord[], query: string, filters: ActiveFilters): MemoryRecord[] {
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

  const { data, isLoading, error } = useApiQuery(
    () => searchMemory({ agentId: MOCK_AGENT_ID, query: searchQuery || "all", limit: 50 }),
    [searchQuery],
  )

  const allRecords: MemoryRecord[] = useMemo(() => {
    if (data?.results && data.results.length > 0) return data.results
    if (error || isMockEnabled() || (!isLoading && (!data?.results || data.results.length === 0))) {
      return generateMockMemories()
    }
    return data?.results ?? []
  }, [data, error, isLoading])

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
    return allRecords
      .filter((r) => r.id !== selectedId)
      .slice(0, 4)
  }, [allRecords, selectedId, selectedRecord])

  const handleSearch = useCallback((query: string, filters: ActiveFilters) => {
    setSearchQuery(query)
    setActiveFilters(filters)
  }, [])

  const handleSelectResult = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  const handleSync = useCallback(async () => {
    await syncMemory(MOCK_AGENT_ID)
  }, [])

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
    agentId: MOCK_AGENT_ID,
  }
}
