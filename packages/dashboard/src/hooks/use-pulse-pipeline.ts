"use client"

import { useCallback, useMemo, useState } from "react"

import type { ContentFilterState } from "@/components/pulse/content-filters"
import { useApiQuery } from "@/hooks/use-api"
import type { ContentPiece, ContentPipelineStats } from "@/lib/api-client"
import { archiveContent, listContent, publishContent } from "@/lib/api-client"
import { isMockEnabled } from "@/lib/mock"
import { generateMockContent } from "@/lib/mock/content"

function computeStats(pieces: ContentPiece[]): ContentPipelineStats {
  const now = Date.now()
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const publishedToday = pieces.filter(
    (p) => p.publishedAt && new Date(p.publishedAt).getTime() >= todayStart.getTime(),
  ).length

  const reviewPieces = pieces.filter((p) => p.status === "IN_REVIEW")
  const avgReviewTimeMs =
    reviewPieces.length > 0
      ? reviewPieces.reduce((sum, p) => sum + (now - new Date(p.createdAt).getTime()), 0) /
        reviewPieces.length
      : 0

  return {
    totalPieces: pieces.length,
    publishedToday,
    avgReviewTimeMs,
    pendingReview: reviewPieces.length,
  }
}

export function usePulsePipeline() {
  const [filters, setFilters] = useState<ContentFilterState>({
    search: "",
    type: "ALL",
    agent: "ALL",
  })
  const [publishingId, setPublishingId] = useState<string | null>(null)

  const {
    data,
    isLoading,
    error: rawError,
    errorCode: rawErrorCode,
  } = useApiQuery(() => listContent({ limit: 100 }), [])

  // A 404 means the /content route isn't deployed — not a connection failure.
  const error = rawErrorCode === "NOT_FOUND" ? null : rawError
  const errorCode = rawErrorCode === "NOT_FOUND" ? null : rawErrorCode

  const allPieces: ContentPiece[] = useMemo(() => {
    if (isMockEnabled()) return generateMockContent()
    if (data?.content) return data.content
    return []
  }, [data])

  const filteredPieces = useMemo(() => {
    return allPieces.filter((p) => {
      if (filters.type !== "ALL" && p.type !== filters.type) return false
      if (filters.agent !== "ALL" && p.agentName !== filters.agent) return false
      if (filters.search) {
        const q = filters.search.toLowerCase()
        return (
          p.title.toLowerCase().includes(q) ||
          p.body.toLowerCase().includes(q) ||
          p.agentName.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [allPieces, filters])

  const stats = useMemo(() => computeStats(allPieces), [allPieces])
  const agentNames = useMemo(
    () => [...new Set(allPieces.map((p) => p.agentName))].sort(),
    [allPieces],
  )

  const publishingPiece = useMemo(
    () => allPieces.find((p) => p.id === publishingId),
    [allPieces, publishingId],
  )

  const handlePublish = useCallback(async (contentId: string, channel: string): Promise<void> => {
    await publishContent(contentId, channel)
  }, [])

  const handleArchive = useCallback(async (contentId: string): Promise<void> => {
    await archiveContent(contentId)
  }, [])

  return {
    pieces: allPieces,
    filteredPieces,
    stats,
    agentNames,
    filters,
    setFilters,
    publishingId,
    setPublishingId,
    publishingPiece,
    handlePublish,
    handleArchive,
    isLoading,
    error,
    errorCode: errorCode,
  }
}
