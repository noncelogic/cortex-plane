"use client"

import { useCallback, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { CapabilityAuditEntry } from "@/lib/api/tool-bindings"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventBadge(eventType: string): { label: string; className: string } {
  switch (eventType) {
    case "binding_created":
      return {
        label: "Created",
        className: "bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20",
      }
    case "binding_removed":
      return {
        label: "Removed",
        className: "bg-red-500/10 text-red-400 ring-1 ring-red-500/20",
      }
    case "tool_invoked":
      return {
        label: "Invoked",
        className: "bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20",
      }
    default:
      return {
        label: eventType,
        className: "bg-slate-500/10 text-slate-400 ring-1 ring-slate-500/20",
      }
  }
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CapabilityAuditTableProps {
  entries: CapabilityAuditEntry[]
  total: number
  limit: number
  offset: number
  onPageChange: (offset: number) => void
  onFilterChange: (filters: { toolRef?: string; eventType?: string }) => void
  loading?: boolean
}

export function CapabilityAuditTable({
  entries,
  total,
  limit,
  offset,
  onPageChange,
  onFilterChange,
  loading,
}: CapabilityAuditTableProps): React.JSX.Element {
  const [toolRefFilter, setToolRefFilter] = useState("")
  const [eventTypeFilter, setEventTypeFilter] = useState("")

  const applyFilters = useCallback(() => {
    onFilterChange({
      toolRef: toolRefFilter || undefined,
      eventType: eventTypeFilter || undefined,
    })
  }, [toolRefFilter, eventTypeFilter, onFilterChange])

  const totalPages = Math.max(1, Math.ceil(total / limit))
  const currentPage = Math.floor(offset / limit) + 1

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[160px]">
          <label className="mb-1 block text-xs font-medium text-text-muted">Tool Ref</label>
          <Input
            icon="search"
            placeholder="Filter by tool..."
            value={toolRefFilter}
            onChange={(e) => setToolRefFilter(e.target.value)}
          />
        </div>
        <div className="min-w-[160px]">
          <label className="mb-1 block text-xs font-medium text-text-muted">Event Type</label>
          <select
            value={eventTypeFilter}
            onChange={(e) => setEventTypeFilter(e.target.value)}
            className="w-full rounded-lg border border-surface-border bg-surface-light px-3 py-2 text-sm text-text-main focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            <option value="">All</option>
            <option value="binding_created">Created</option>
            <option value="binding_removed">Removed</option>
            <option value="tool_invoked">Invoked</option>
          </select>
        </div>
        <Button size="sm" onClick={applyFilters}>
          <span className="material-symbols-outlined text-sm">filter_list</span>
          Apply
        </Button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-surface-border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-surface-border bg-secondary/30">
              <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                Timestamp
              </th>
              <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                Event
              </th>
              <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                Tool
              </th>
              <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                Details
              </th>
              <th className="px-3 py-2 text-xs font-bold uppercase tracking-widest text-text-muted">
                Actor
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-text-muted">
                  Loading...
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-sm text-text-muted">
                  No audit entries found
                </td>
              </tr>
            ) : (
              entries.map((entry) => {
                const badge = eventBadge(entry.eventType)
                return (
                  <tr
                    key={entry.id}
                    className="border-b border-surface-border last:border-b-0 hover:bg-secondary/20"
                  >
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-text-muted">
                      {formatTimestamp(entry.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-text-main">{entry.toolRef}</td>
                    <td className="max-w-[200px] truncate px-3 py-2 text-xs text-text-muted">
                      {JSON.stringify(entry.details)}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-muted">
                      {entry.actorUserId ?? entry.jobId ?? "—"}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-muted">
            Page {currentPage} of {totalPages} ({total} total)
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={offset === 0}
              onClick={() => onPageChange(Math.max(0, offset - limit))}
            >
              <span className="material-symbols-outlined text-sm">chevron_left</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={offset + limit >= total}
              onClick={() => onPageChange(offset + limit)}
            >
              <span className="material-symbols-outlined text-sm">chevron_right</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
