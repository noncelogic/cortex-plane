"use client"

import { useEffect, useRef } from "react"

import type { BrowserTab } from "@/lib/api-client"

interface TabBarProps {
  tabs: BrowserTab[]
  onSelectTab?: (tabId: string) => void
  onCloseTab?: (tabId: string) => void
}

export function TabBar({ tabs, onSelectTab, onCloseTab }: TabBarProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // Auto-scroll active tab into view
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
  }, [tabs])

  if (tabs.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-chrome-border bg-chrome-bg px-3 py-2">
        <span className="material-symbols-outlined text-sm text-slate-600">tab</span>
        <span className="text-xs text-slate-500">No tabs open</span>
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className="flex gap-1 overflow-x-auto rounded-lg border border-chrome-border bg-chrome-bg p-1 scrollbar-none"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={tab.active ? activeRef : undefined}
          type="button"
          onClick={() => onSelectTab?.(tab.id)}
          className={`group relative flex min-w-0 shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors ${
            tab.active
              ? "bg-surface-border text-white"
              : "text-slate-400 hover:bg-surface-border/50 hover:text-slate-200"
          }`}
        >
          {/* Favicon placeholder */}
          {tab.favicon ? (
            <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-sm" />
          ) : (
            <span className="material-symbols-outlined shrink-0 text-sm text-slate-500">
              language
            </span>
          )}

          {/* Title - truncated */}
          <span className="max-w-[120px] truncate text-xs">{tab.title}</span>

          {/* Active indicator dot */}
          {tab.active && (
            <span className="absolute bottom-0 left-1/2 size-1 -translate-x-1/2 rounded-full bg-primary" />
          )}

          {/* Close button */}
          {onCloseTab && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                onCloseTab(tab.id)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation()
                  onCloseTab(tab.id)
                }
              }}
              className="ml-1 hidden rounded p-0.5 text-slate-500 transition-colors hover:bg-slate-700 hover:text-slate-200 group-hover:block"
            >
              <span className="material-symbols-outlined text-xs">close</span>
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
