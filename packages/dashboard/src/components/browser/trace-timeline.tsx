"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import type { BrowserEvent, BrowserEventType } from "@/lib/api-client"
import { duration } from "@/lib/format"

interface TraceTimelineProps {
  events: BrowserEvent[]
}

const EVENT_CONFIG: Record<
  BrowserEventType,
  { icon: string; label: string; colorClass: string; bgClass: string }
> = {
  GET: {
    icon: "language",
    label: "GET",
    colorClass: "text-blue-400",
    bgClass: "bg-blue-500/10 border-blue-500/20",
  },
  CLICK: {
    icon: "ads_click",
    label: "Click",
    colorClass: "text-amber-400",
    bgClass: "bg-amber-500/10 border-amber-500/20",
  },
  CONSOLE: {
    icon: "terminal",
    label: "Console",
    colorClass: "text-slate-400",
    bgClass: "bg-slate-500/10 border-slate-500/20",
  },
  SNAPSHOT: {
    icon: "photo_camera",
    label: "Snapshot",
    colorClass: "text-purple-400",
    bgClass: "bg-purple-500/10 border-purple-500/20",
  },
  NAVIGATE: {
    icon: "explore",
    label: "Navigate",
    colorClass: "text-emerald-400",
    bgClass: "bg-emerald-500/10 border-emerald-500/20",
  },
  ERROR: {
    icon: "warning",
    label: "Error",
    colorClass: "text-red-400",
    bgClass: "bg-red-500/10 border-red-500/20",
  },
}

const ALL_EVENT_TYPES: BrowserEventType[] = [
  "GET",
  "CLICK",
  "CONSOLE",
  "SNAPSHOT",
  "NAVIGATE",
  "ERROR",
]

export function TraceTimeline({ events }: TraceTimelineProps): React.JSX.Element {
  const [activeFilters, setActiveFilters] = useState<Set<BrowserEventType>>(
    new Set(ALL_EVENT_TYPES),
  )
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to latest
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [events])

  const filteredEvents = useMemo(
    () => events.filter((e) => activeFilters.has(e.type)),
    [events, activeFilters],
  )

  const toggleFilter = (type: BrowserEventType) => {
    setActiveFilters((prev) => {
      const next = new Set(prev)
      if (next.has(type)) {
        // Don't allow removing all filters
        if (next.size > 1) next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
  }

  return (
    <div className="flex flex-col rounded-xl border border-[#2d2d3b] bg-[#1c1c27]">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-1.5 border-b border-[#2d2d3b] px-3 py-2">
        {ALL_EVENT_TYPES.map((type) => {
          const config = EVENT_CONFIG[type]
          const isActive = activeFilters.has(type)
          return (
            <button
              key={type}
              type="button"
              onClick={() => toggleFilter(type)}
              className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                isActive
                  ? `border ${config.bgClass} ${config.colorClass}`
                  : "border border-transparent text-slate-600 hover:text-slate-400"
              }`}
            >
              <span className="material-symbols-outlined text-xs">{config.icon}</span>
              {config.label}
            </button>
          )
        })}
      </div>

      {/* Timeline */}
      <div ref={scrollRef} className="max-h-[400px] overflow-y-auto p-3">
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8">
            <span className="material-symbols-outlined mb-2 text-2xl text-slate-600">
              timeline
            </span>
            <p className="text-xs text-slate-500">No events to display</p>
          </div>
        ) : (
          <div className="space-y-0">
            {filteredEvents.map((event, i) => (
              <EventItem
                key={event.id}
                event={event}
                isLast={i === filteredEvents.length - 1}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Event item
// ---------------------------------------------------------------------------

function EventItem({
  event,
  isLast,
}: {
  event: BrowserEvent
  isLast: boolean
}): React.JSX.Element {
  const config = EVENT_CONFIG[event.type]
  const time = new Date(event.timestamp).toLocaleTimeString("en-US", { hour12: false })

  return (
    <div className="relative flex gap-3 pb-4 last:pb-0">
      {/* Vertical connector */}
      {!isLast && (
        <div className="absolute left-[11px] top-6 h-[calc(100%-12px)] w-px bg-[#2d2d3b]" />
      )}

      {/* Icon dot */}
      <div className="relative z-10 mt-0.5 flex-shrink-0">
        <div
          className={`flex size-[22px] items-center justify-center rounded-full border ${config.bgClass}`}
        >
          <span className={`material-symbols-outlined text-xs ${config.colorClass}`}>
            {config.icon}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${config.bgClass} ${config.colorClass}`}
          >
            {config.label}
          </span>
          <span className="font-mono text-[10px] text-slate-600">{time}</span>
          {event.durationMs !== undefined && (
            <span className="font-mono text-[10px] text-slate-500">
              {duration(event.durationMs)}
            </span>
          )}
        </div>

        {/* URL / selector / message */}
        {event.url && (
          <p className="mt-1 truncate font-mono text-xs text-slate-400" title={event.url}>
            {event.url}
          </p>
        )}
        {event.selector && (
          <p className="mt-1 truncate font-mono text-xs text-amber-300/70" title={event.selector}>
            {event.selector}
          </p>
        )}
        {event.message && (
          <p
            className={`mt-1 truncate text-xs ${
              event.type === "ERROR" ? "text-red-300/70" : "text-slate-400"
            }`}
            title={event.message}
          >
            {event.message}
          </p>
        )}
      </div>
    </div>
  )
}
