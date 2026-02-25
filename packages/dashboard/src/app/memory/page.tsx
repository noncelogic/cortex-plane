"use client"

import { useCallback, useMemo, useState } from "react"

import { DocumentViewer } from "@/components/memory/document-viewer"
import { MemoryResults } from "@/components/memory/memory-results"
import { type ActiveFilters, MemorySearch } from "@/components/memory/memory-search"
import { SyncStatus } from "@/components/memory/sync-status"
import { Skeleton } from "@/components/layout/skeleton"
import { useApiQuery } from "@/hooks/use-api"
import type { MemoryRecord } from "@/lib/api-client"
import { searchMemory } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Mock data for development
// ---------------------------------------------------------------------------

const MOCK_AGENT_ID = "agt-cortex-001"

function generateMockMemories(): MemoryRecord[] {
  const now = Date.now()

  return [
    {
      id: "mem-a1b2c3d4-e5f6-7890-abcd-111111111111",
      type: "fact",
      content:
        "Kubernetes cluster uses istio service mesh for inter-service communication.\n\nThe production cluster runs on GKE with 12 node pools spread across 3 zones. Istio is configured with mutual TLS for all east-west traffic.\n\n> Key config: istio-system namespace hosts the control plane with 3 replicas of istiod.\n\n```yaml\n# istio-config.yaml\napiVersion: networking.istio.io/v1beta1\nkind: VirtualService\nmetadata:\n  name: cortex-api\nspec:\n  hosts:\n    - cortex-api.prod.svc.cluster.local\n  http:\n    - route:\n        - destination:\n            host: cortex-api\n            port:\n              number: 8080\n```\n\nRetry policies are set to 3 attempts with exponential backoff.",
      tags: ["kubernetes", "istio", "service-mesh", "infrastructure"],
      people: ["sarah-chen", "platform-team"],
      projects: ["cortex-infra"],
      importance: 5,
      confidence: 0.95,
      source: "agent-observation",
      createdAt: now - 2 * 86_400_000,
      accessCount: 47,
      lastAccessedAt: now - 3_600_000,
      score: 0.97,
    },
    {
      id: "mem-b2c3d4e5-f6a7-8901-bcde-222222222222",
      type: "preference",
      content:
        "Team prefers blue-green deployments over canary for stateful services.\n\nAfter the incident in Q3 2025, the SRE team decided that stateful services (databases, message queues) should use blue-green deployments to avoid split-brain scenarios during canary rollouts.",
      tags: ["deployment", "sre", "best-practices"],
      people: ["ops-team", "mike-wilson"],
      projects: ["cortex-deploy"],
      importance: 4,
      confidence: 0.88,
      source: "team-discussion",
      createdAt: now - 5 * 86_400_000,
      accessCount: 23,
      lastAccessedAt: now - 7_200_000,
      score: 0.91,
    },
    {
      id: "mem-c3d4e5f6-a7b8-9012-cdef-333333333333",
      type: "event",
      content:
        "Production outage on 2025-12-15: Redis cluster failover caused 4 minutes of elevated latency.\n\nRoot cause: The sentinel quorum was misconfigured after the last scaling event. The failover triggered correctly but took longer than expected due to stale DNS cache entries in the application pods.",
      tags: ["incident", "redis", "outage", "post-mortem"],
      people: ["sarah-chen", "incident-response"],
      projects: ["cortex-infra"],
      importance: 5,
      confidence: 0.99,
      source: "incident-report",
      createdAt: now - 72 * 86_400_000,
      accessCount: 15,
      lastAccessedAt: now - 86_400_000,
      score: 0.84,
    },
    {
      id: "mem-d4e5f6a7-b8c9-0123-defa-444444444444",
      type: "system_rule",
      content:
        "All agent-generated code changes must pass CI/CD pipeline with >80% test coverage before merging.\n\nThis rule applies to all autonomous code modifications. Human review is required for changes touching security-sensitive paths (auth/, crypto/, permissions/).",
      tags: ["ci-cd", "code-quality", "guardrails"],
      people: [],
      projects: ["cortex-governance"],
      importance: 5,
      confidence: 1.0,
      source: "governance-policy",
      createdAt: now - 30 * 86_400_000,
      accessCount: 89,
      lastAccessedAt: now - 1_800_000,
      score: 0.78,
    },
    {
      id: "mem-e5f6a7b8-c9d0-1234-efab-555555555555",
      type: "fact",
      content:
        "The model inference service scales to a maximum of 24 GPU instances.\n\nEach instance runs 2x A100 80GB GPUs with NVLink. Auto-scaling is configured with a target GPU utilization of 70% and a cooldown period of 300 seconds.",
      tags: ["gpu", "scaling", "inference", "resources"],
      people: ["ml-infra-team"],
      projects: ["cortex-ml"],
      importance: 4,
      confidence: 0.92,
      source: "config-file",
      createdAt: now - 14 * 86_400_000,
      accessCount: 31,
      lastAccessedAt: now - 14_400_000,
      score: 0.88,
    },
    {
      id: "mem-f6a7b8c9-d0e1-2345-fabc-666666666666",
      type: "preference",
      content:
        "Use structured logging with JSON format for all microservices.\n\nStandard fields: timestamp, level, service, traceId, spanId, message. Use Pino for Node.js services and structlog for Python services.",
      tags: ["logging", "observability", "standards"],
      people: ["platform-team"],
      projects: ["cortex-platform"],
      importance: 3,
      confidence: 0.85,
      source: "engineering-handbook",
      createdAt: now - 60 * 86_400_000,
      accessCount: 42,
      lastAccessedAt: now - 43_200_000,
      score: 0.72,
    },
    {
      id: "mem-a7b8c9d0-e1f2-3456-abcd-777777777777",
      type: "event",
      content:
        "Successfully migrated from PostgreSQL 14 to PostgreSQL 16 on 2026-01-20.\n\nThe migration was zero-downtime using pglogical replication. Total migration window was 45 minutes. Performance improved by ~12% for complex queries due to improved query planner.",
      tags: ["migration", "postgresql", "database"],
      people: ["db-team", "alex-kumar"],
      projects: ["cortex-data"],
      importance: 4,
      confidence: 0.97,
      source: "migration-log",
      createdAt: now - 36 * 86_400_000,
      accessCount: 8,
      lastAccessedAt: now - 172_800_000,
      score: 0.65,
    },
    {
      id: "mem-b8c9d0e1-f2a3-4567-bcde-888888888888",
      type: "system_rule",
      content:
        "Agents must not create, modify, or delete IAM roles or security groups without human approval.\n\nThis is a critical safety guardrail. Any attempt to modify cloud IAM or network security must go through the approval queue. Auto-approve is explicitly disabled for these action types.",
      tags: ["security", "iam", "guardrails", "compliance"],
      people: [],
      projects: ["cortex-governance"],
      importance: 5,
      confidence: 1.0,
      source: "security-policy",
      createdAt: now - 90 * 86_400_000,
      accessCount: 134,
      lastAccessedAt: now - 600_000,
      score: 0.58,
    },
  ]
}

// ---------------------------------------------------------------------------
// Filter logic
// ---------------------------------------------------------------------------

function applyFilters(records: MemoryRecord[], query: string, filters: ActiveFilters): MemoryRecord[] {
  return records.filter((r) => {
    // Text search
    if (query) {
      const q = query.toLowerCase()
      const matches =
        r.content.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)) ||
        r.source.toLowerCase().includes(q)
      if (!matches) return false
    }

    // Type filter
    if (filters.type !== "ALL" && r.type !== filters.type) return false

    // Importance filter
    if (filters.importance !== "ALL") {
      if (filters.importance === "high" && r.importance < 4) return false
      if (filters.importance === "medium" && r.importance !== 3) return false
      if (filters.importance === "low" && r.importance > 2) return false
    }

    // Score threshold
    if (filters.scoreThreshold > 0 && r.score !== undefined) {
      if (r.score * 100 < filters.scoreThreshold) return false
    }

    // Time range
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MemoryPage(): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>({
    type: "ALL",
    importance: "ALL",
    scoreThreshold: 0,
    timeRange: "ALL",
  })

  // Fetch from API; fall back to mock data
  const { data, isLoading, error } = useApiQuery(
    () => searchMemory({ agentId: MOCK_AGENT_ID, query: searchQuery || "all", limit: 50 }),
    [searchQuery],
  )

  const allRecords: MemoryRecord[] = useMemo(() => {
    if (data?.results && data.results.length > 0) return data.results
    if (error || (!isLoading && (!data?.results || data.results.length === 0))) {
      return generateMockMemories()
    }
    return data?.results ?? []
  }, [data, error, isLoading])

  // Apply client-side filters
  const filteredRecords = useMemo(
    () => applyFilters(allRecords, searchQuery, activeFilters),
    [allRecords, searchQuery, activeFilters],
  )

  // Selected record
  const selectedRecord = useMemo(
    () => allRecords.find((r) => r.id === selectedId) ?? null,
    [allRecords, selectedId],
  )

  // Related records (exclude the selected one, take top 4)
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
          <SyncStatus agentId={MOCK_AGENT_ID} />
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
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-6 py-4 text-sm text-red-500">
          Failed to search memories: {error}
        </div>
      )}

      {/* Split view: Results (left) | Document Viewer (right) */}
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
    </div>
  )
}
