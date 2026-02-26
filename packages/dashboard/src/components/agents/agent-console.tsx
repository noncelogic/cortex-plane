"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { type AgentEventPayload, useAgentStream } from "@/hooks/use-agent-stream"

interface AgentConsoleProps {
  agentId: string
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

type Severity = "info" | "warn" | "error" | "success" | "system"

function classifySeverity(event: AgentEventPayload): Severity {
  switch (event.type) {
    case "agent:error":
      return "error"
    case "agent:complete":
      return "success"
    case "agent:state":
      return "system"
    case "steer:ack":
      return event.data.status === "rejected" ? "warn" : "info"
    case "agent:output": {
      const t = event.data.output.type?.toLowerCase() ?? ""
      if (t.includes("error") || t.includes("err")) return "error"
      if (t.includes("warn")) return "warn"
      return "info"
    }
  }
}

const severityColors: Record<Severity, string> = {
  info: "text-slate-300",
  warn: "text-amber-400",
  error: "text-red-400",
  success: "text-emerald-400",
  system: "text-primary/80",
}

const severityLabels: Record<Severity, string> = {
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  success: "DONE",
  system: "STATE",
}

const severityLabelColors: Record<Severity, string> = {
  info: "text-slate-500",
  warn: "text-amber-500",
  error: "text-red-500",
  success: "text-emerald-500",
  system: "text-purple-400",
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    return ""
  }
}

function getTimestamp(event: AgentEventPayload): string {
  return event.data.timestamp ?? ""
}

function getContent(event: AgentEventPayload): string {
  switch (event.type) {
    case "agent:output":
      return event.data.output.content ?? JSON.stringify(event.data.output)
    case "agent:state":
      return `State transition: ${event.data.state}${event.data.reason ? ` (${event.data.reason})` : ""}`
    case "agent:error":
      return event.data.message
    case "agent:complete":
      return event.data.summary ?? "Job complete"
    case "steer:ack":
      return `Steer ${event.data.status}: ${event.data.steerMessageId}`
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentConsole({ agentId }: AgentConsoleProps): React.JSX.Element {
  const { events, connected, status } = useAgentStream(agentId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const userScrolledRef = useRef(false)

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events, autoScroll])

  // Detect user scroll to disable auto-scroll
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const atBottom = scrollHeight - scrollTop - clientHeight < 40
    if (!atBottom && !userScrolledRef.current) {
      userScrolledRef.current = true
      setAutoScroll(false)
    } else if (atBottom && userScrolledRef.current) {
      userScrolledRef.current = false
      setAutoScroll(true)
    }
  }, [])

  const jumpToLatest = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    setAutoScroll(true)
    userScrolledRef.current = false
  }, [])

  const copyLine = useCallback(async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIndex(index)
      setTimeout(() => setCopiedIndex(null), 1500)
    } catch {
      // clipboard not available
    }
  }, [])

  const streamingLabel =
    status === "connected" ? "Streaming" : status === "connecting" ? "Connecting" : "Disconnected"

  const streamingDot =
    status === "connected"
      ? "bg-emerald-500"
      : status === "connecting"
        ? "bg-amber-500 animate-pulse"
        : "bg-slate-500"

  return (
    <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-surface-border">
      {/* Console header */}
      <div className="flex items-center justify-between border-b border-surface-border bg-console-bg px-4 py-2.5">
        <div className="flex items-center gap-3">
          {/* Traffic light dots */}
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-red-500/50" />
            <span className="size-2.5 rounded-full bg-amber-500/50" />
            <span className="size-2.5 rounded-full bg-emerald-500/50" />
          </div>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-sm text-slate-400">terminal</span>
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
              Agent Output
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Streaming indicator */}
          <div className="flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full ${streamingDot}`} />
            <span className="font-mono text-[10px] uppercase tracking-widest text-emerald-500">
              {streamingLabel}
            </span>
          </div>
          {/* Download button */}
          <button
            onClick={() => {
              const text = events
                .map(
                  (e) =>
                    `[${formatTimestamp(getTimestamp(e))}] [${severityLabels[classifySeverity(e)]}] ${getContent(e)}`,
                )
                .join("\n")
              const blob = new Blob([text], { type: "text/plain" })
              const url = URL.createObjectURL(blob)
              const a = document.createElement("a")
              a.href = url
              a.download = `agent-${agentId}-output.log`
              a.click()
              URL.revokeObjectURL(url)
            }}
            className="text-slate-500 transition-colors hover:text-slate-300"
            title="Download log"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
          </button>
        </div>
      </div>

      {/* Console body */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scrollbar-hide relative flex-1 overflow-y-auto bg-[#111118] p-4 font-mono text-sm leading-relaxed"
      >
        {events.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <span className="material-symbols-outlined mb-2 text-3xl text-slate-600">
                terminal
              </span>
              <p className="text-sm text-slate-600">
                {connected ? "Waiting for output..." : "Connecting to agent stream..."}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {events.map((event, i) => {
              const severity = classifySeverity(event)
              const ts = getTimestamp(event)
              const content = getContent(event)
              return (
                <div key={i} className="group flex items-start gap-2">
                  {/* Timestamp */}
                  <span className="shrink-0 select-none text-blue-400/60">
                    {formatTimestamp(ts)}
                  </span>
                  {/* Severity label */}
                  <span
                    className={`w-12 shrink-0 select-none text-right text-[10px] font-bold uppercase ${severityLabelColors[severity]}`}
                  >
                    {severityLabels[severity]}
                  </span>
                  {/* Content */}
                  <span
                    className={`flex-1 whitespace-pre-wrap break-words ${severityColors[severity]}`}
                  >
                    {content}
                  </span>
                  {/* Copy button */}
                  <button
                    onClick={() => void copyLine(content, i)}
                    className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                    title="Copy line"
                  >
                    <span className="material-symbols-outlined text-[14px] text-slate-600 hover:text-slate-400">
                      {copiedIndex === i ? "check" : "content_copy"}
                    </span>
                  </button>
                </div>
              )
            })}
            {/* Blinking cursor */}
            <div className="mt-1 flex items-center gap-2">
              <span className="h-4 w-2 animate-pulse bg-primary" />
            </div>
          </div>
        )}
      </div>

      {/* Console footer */}
      <div className="flex items-center justify-between border-t border-surface-border bg-console-bg px-4 py-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {events.length} events
        </span>
        {!autoScroll && (
          <button
            onClick={jumpToLatest}
            className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary transition-colors hover:bg-primary/20"
          >
            <span className="material-symbols-outlined text-[14px]">arrow_downward</span>
            Jump to latest
          </button>
        )}
      </div>
    </div>
  )
}
