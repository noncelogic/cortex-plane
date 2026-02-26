"use client"

import type { ContentType } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentFilterState {
  search: string
  type: ContentType | "ALL"
  agent: string
}

interface ContentFiltersProps {
  filters: ContentFilterState
  onChange: (filters: ContentFilterState) => void
  agentNames: string[]
  totalCount: number
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const TYPE_OPTIONS: { label: string; value: ContentType | "ALL" }[] = [
  { label: "All Types", value: "ALL" },
  { label: "Blog", value: "blog" },
  { label: "Social", value: "social" },
  { label: "Newsletter", value: "newsletter" },
  { label: "Report", value: "report" },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ContentFilters({
  filters,
  onChange,
  agentNames,
  totalCount,
}: ContentFiltersProps): React.JSX.Element {
  const activeFilters = [
    filters.type !== "ALL" ? filters.type : null,
    filters.agent !== "ALL" ? filters.agent : null,
    filters.search ? `"${filters.search}"` : null,
  ].filter(Boolean)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-slate-400">
            search
          </span>
          <input
            type="text"
            value={filters.search}
            onChange={(e) => onChange({ ...filters, search: e.target.value })}
            placeholder="Search content..."
            className="rounded-lg border-none bg-secondary py-2 pl-10 pr-4 text-sm outline-none transition-all focus:ring-2 focus:ring-primary/50"
          />
        </div>

        {/* Type Filter */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-slate-400">
            category
          </span>
          <select
            value={filters.type}
            onChange={(e) =>
              onChange({ ...filters, type: e.target.value as ContentType | "ALL" })
            }
            className="cursor-pointer appearance-none rounded-lg border-none bg-secondary py-2 pl-10 pr-8 text-sm focus:ring-2 focus:ring-primary/50"
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Agent Filter */}
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-slate-400">
            smart_toy
          </span>
          <select
            value={filters.agent}
            onChange={(e) => onChange({ ...filters, agent: e.target.value })}
            className="cursor-pointer appearance-none rounded-lg border-none bg-secondary py-2 pl-10 pr-8 text-sm focus:ring-2 focus:ring-primary/50"
          >
            <option value="ALL">All Agents</option>
            {agentNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        {/* Result count */}
        <div className="ml-auto text-sm text-text-muted">
          <span className="font-bold text-text-main">{totalCount}</span>{" "}
          {totalCount === 1 ? "piece" : "pieces"}
        </div>
      </div>

      {/* Active filter chips */}
      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500">Active filters:</span>
          {activeFilters.map((f) => (
            <span
              key={f}
              className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
            >
              {f}
            </span>
          ))}
          <button
            type="button"
            onClick={() => onChange({ search: "", type: "ALL", agent: "ALL" })}
            className="text-xs text-slate-400 transition-colors hover:text-red-400"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}
