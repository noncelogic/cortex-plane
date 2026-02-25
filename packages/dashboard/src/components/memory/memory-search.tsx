"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { MemoryRecord } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MemoryType = MemoryRecord["type"]
type ImportanceLevel = "ALL" | "high" | "medium" | "low"
type TimeRange = "ALL" | "24h" | "7d" | "30d" | "90d"

interface ActiveFilters {
  type: MemoryType | "ALL"
  importance: ImportanceLevel
  scoreThreshold: number
  timeRange: TimeRange
}

interface MemorySearchProps {
  onSearch: (query: string, filters: ActiveFilters) => void
  isLoading?: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TYPE_OPTIONS: { label: string; value: MemoryType | "ALL" }[] = [
  { label: "All Types", value: "ALL" },
  { label: "Fact", value: "fact" },
  { label: "Preference", value: "preference" },
  { label: "Event", value: "event" },
  { label: "System Rule", value: "system_rule" },
]

const IMPORTANCE_OPTIONS: { label: string; value: ImportanceLevel }[] = [
  { label: "Any Importance", value: "ALL" },
  { label: "High (4-5)", value: "high" },
  { label: "Medium (3)", value: "medium" },
  { label: "Low (1-2)", value: "low" },
]

const TIME_OPTIONS: { label: string; value: TimeRange }[] = [
  { label: "Any Time", value: "ALL" },
  { label: "Last 24h", value: "24h" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 90 days", value: "90d" },
]

const DEFAULT_FILTERS: ActiveFilters = {
  type: "ALL",
  importance: "ALL",
  scoreThreshold: 0,
  timeRange: "ALL",
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type { ActiveFilters, MemoryType, ImportanceLevel, TimeRange }

export function MemorySearch({ onSearch, isLoading }: MemorySearchProps): React.JSX.Element {
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<ActiveFilters>(DEFAULT_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)
  const onSearchRef = useRef(onSearch)
  onSearchRef.current = onSearch

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      onSearchRef.current(query, filters)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, filters])

  const updateFilter = useCallback(<K extends keyof ActiveFilters>(key: K, value: ActiveFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])

  const clearFilter = useCallback((key: keyof ActiveFilters) => {
    setFilters((prev) => ({ ...prev, [key]: DEFAULT_FILTERS[key] }))
  }, [])

  const hasActiveFilters =
    filters.type !== "ALL" ||
    filters.importance !== "ALL" ||
    filters.scoreThreshold > 0 ||
    filters.timeRange !== "ALL"

  return (
    <div className="space-y-3">
      {/* Search Input */}
      <div className="relative">
        <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-xl text-slate-400">
          search
        </span>
        <input
          type="text"
          value={query}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          placeholder="Search memories semantically..."
          className="w-full rounded-xl border-none bg-bg-dark py-3 pl-12 pr-12 text-sm text-slate-100 placeholder-slate-500 outline-none transition-all focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
        />
        <button
          type="button"
          onClick={() => setShowFilters(!showFilters)}
          className={`absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 transition-colors ${
            showFilters || hasActiveFilters
              ? "bg-primary/10 text-primary"
              : "text-slate-400 hover:text-slate-300"
          }`}
          title="Toggle filters"
        >
          <span className="material-symbols-outlined text-xl">tune</span>
        </button>
        {isLoading && (
          <div className="absolute right-14 top-1/2 -translate-y-1/2">
            <div className="size-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          </div>
        )}
      </div>

      {/* Filter Chips */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2">
          {/* Type filter */}
          <FilterChip
            label={TYPE_OPTIONS.find((o) => o.value === filters.type)?.label ?? "All Types"}
            active={filters.type !== "ALL"}
            onClear={() => clearFilter("type")}
          >
            <select
              value={filters.type}
              onChange={(e) => updateFilter("type", e.target.value as MemoryType | "ALL")}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FilterChip>

          {/* Importance filter */}
          <FilterChip
            label={IMPORTANCE_OPTIONS.find((o) => o.value === filters.importance)?.label ?? "Any Importance"}
            active={filters.importance !== "ALL"}
            onClear={() => clearFilter("importance")}
          >
            <select
              value={filters.importance}
              onChange={(e) => updateFilter("importance", e.target.value as ImportanceLevel)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {IMPORTANCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FilterChip>

          {/* Score threshold */}
          <FilterChip
            label={filters.scoreThreshold > 0 ? `Score ≥ ${filters.scoreThreshold}%` : "Score Threshold"}
            active={filters.scoreThreshold > 0}
            onClear={() => clearFilter("scoreThreshold")}
          >
            <select
              value={filters.scoreThreshold}
              onChange={(e) => updateFilter("scoreThreshold", Number(e.target.value))}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              <option value={0}>Any Score</option>
              <option value={50}>≥ 50%</option>
              <option value={70}>≥ 70%</option>
              <option value={85}>≥ 85%</option>
              <option value={95}>≥ 95%</option>
            </select>
          </FilterChip>

          {/* Time range */}
          <FilterChip
            label={TIME_OPTIONS.find((o) => o.value === filters.timeRange)?.label ?? "Any Time"}
            active={filters.timeRange !== "ALL"}
            onClear={() => clearFilter("timeRange")}
          >
            <select
              value={filters.timeRange}
              onChange={(e) => updateFilter("timeRange", e.target.value as TimeRange)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {TIME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FilterChip>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter Chip
// ---------------------------------------------------------------------------

function FilterChip({
  label,
  active,
  onClear,
  children,
}: {
  label: string
  active: boolean
  onClear: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={`relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-primary/20 bg-primary/10 text-primary"
          : "border-slate-700 bg-bg-dark text-slate-400"
      }`}
    >
      <span>{label}</span>
      {active && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onClear()
          }}
          className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
        >
          <span className="material-symbols-outlined text-xs">close</span>
        </button>
      )}
      {children}
    </div>
  )
}
