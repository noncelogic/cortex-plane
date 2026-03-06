"use client"

import { useState } from "react"

import type { McpServerTool } from "@/lib/api-client"

interface McpToolListProps {
  tools: McpServerTool[]
}

function ToolStatusBadge({ status }: { status: string }): React.JSX.Element {
  const isAvailable = status === "available"
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
        isAvailable
          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-slate-400/20 bg-slate-400/10 text-slate-500 dark:text-slate-400"
      }`}
    >
      <span className={`size-1 rounded-full ${isAvailable ? "bg-emerald-500" : "bg-slate-400"}`} />
      {status}
    </span>
  )
}

export function McpToolList({ tools }: McpToolListProps): React.JSX.Element {
  const [search, setSearch] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)

  const filtered = tools.filter((t) => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      t.name.toLowerCase().includes(q) ||
      (t.description ?? "").toLowerCase().includes(q) ||
      t.qualified_name.toLowerCase().includes(q)
    )
  })

  if (tools.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-surface-border px-6 py-10 text-center">
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-primary/10">
          <span className="material-symbols-outlined text-[20px] text-primary">build</span>
        </div>
        <h3 className="text-sm font-bold text-text-main dark:text-white">No tools discovered</h3>
        <p className="mt-1 max-w-sm text-xs text-text-muted">
          Tools will appear here after the server is probed successfully.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Search */}
      {tools.length > 5 && (
        <div className="relative">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-slate-400">
            search
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tools..."
            className="w-full rounded-lg border-none bg-slate-100 py-2 pl-10 pr-4 text-sm outline-none transition-all focus:ring-2 focus:ring-primary/50 dark:bg-slate-800"
          />
        </div>
      )}

      {/* Tool list */}
      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900/40">
        {filtered.map((tool) => (
          <div key={tool.id} className="px-4 py-3">
            <button
              type="button"
              onClick={() => setExpanded(expanded === tool.id ? null : tool.id)}
              className="flex w-full items-center gap-3 text-left"
            >
              <span className="material-symbols-outlined text-[18px] text-primary">build</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-text-main dark:text-white">
                    {tool.name}
                  </span>
                  <ToolStatusBadge status={tool.status} />
                </div>
                {tool.description && (
                  <p className="mt-0.5 truncate text-xs text-text-muted">{tool.description}</p>
                )}
              </div>
              <span
                className={`material-symbols-outlined text-[16px] text-text-muted transition-transform ${expanded === tool.id ? "rotate-180" : ""}`}
              >
                expand_more
              </span>
            </button>

            {/* Expanded: show input schema */}
            {expanded === tool.id && (
              <div className="mt-3 ml-8 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                  Input Schema
                </p>
                <pre className="overflow-x-auto text-xs text-text-muted leading-relaxed">
                  {JSON.stringify(tool.input_schema, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Count */}
      <p className="text-xs text-text-muted">
        {filtered.length === tools.length
          ? `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`
          : `${filtered.length} of ${tools.length} tools`}
      </p>
    </div>
  )
}
