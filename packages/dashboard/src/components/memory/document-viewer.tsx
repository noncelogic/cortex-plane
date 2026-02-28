"use client"

import { useCallback, useState } from "react"

import type { MemoryRecord } from "@/lib/api-client"
import { truncateUuid } from "@/lib/format"

import { RelatedPanel } from "./related-panel"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocumentViewerProps {
  record: MemoryRecord | null
  relatedRecords?: MemoryRecord[]
  onSelectRelated?: (id: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function typeIcon(type: MemoryRecord["type"]): string {
  const icons: Record<MemoryRecord["type"], string> = {
    fact: "lightbulb",
    preference: "tune",
    event: "event",
    system_rule: "gavel",
  }
  return icons[type]
}

function typeLabel(type: MemoryRecord["type"]): string {
  const labels: Record<MemoryRecord["type"], string> = {
    fact: "Fact",
    preference: "Preference",
    event: "Event",
    system_rule: "System Rule",
  }
  return labels[type]
}

function importanceStars(importance: number): string {
  return "★".repeat(importance) + "☆".repeat(5 - importance)
}

function relativeTimeFromEpoch(epoch: number): string {
  const diff = Date.now() - epoch
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocumentViewer({
  record,
  relatedRecords,
  onSelectRelated,
}: DocumentViewerProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    if (!record) return
    void navigator.clipboard.writeText(record.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [record])

  // Empty state
  if (!record) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-surface-dark">
          <span className="material-symbols-outlined text-3xl text-slate-500">description</span>
        </div>
        <h3 className="text-lg font-semibold text-slate-300">No memory selected</h3>
        <p className="mt-1 max-w-sm text-sm text-slate-500">
          Select a memory from the results to view its full content and metadata.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto scrollbar-hide">
      {/* Document header */}
      <div className="border-b border-slate-800 p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {/* Verified source badge */}
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
            <span className="material-symbols-outlined text-sm">verified</span>
            Verified Source
          </span>
          {/* Memory ID */}
          <span className="rounded-full bg-slate-800 px-2.5 py-1 font-mono text-xs text-slate-400">
            {truncateUuid(record.id)}
          </span>
        </div>

        {/* Title */}
        <h2 className="text-3xl font-bold text-slate-100">{extractTitle(record.content)}</h2>

        {/* Source & time */}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-400">
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-base">source</span>
            {record.source}
          </span>
          <span className="flex items-center gap-1">
            <span className="material-symbols-outlined text-base">schedule</span>
            Updated {relativeTimeFromEpoch(record.createdAt)}
          </span>
        </div>

        {/* Action buttons */}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700"
          >
            <span className="material-symbols-outlined text-sm">
              {copied ? "check" : "content_copy"}
            </span>
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!record) return
              const blob = new Blob([record.content], { type: "text/plain" })
              const url = URL.createObjectURL(blob)
              window.open(url, "_blank")
            }}
            className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700"
          >
            <span className="material-symbols-outlined text-sm">open_in_new</span>
            Open
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 p-6">
        <div className="prose prose-invert max-w-none">
          <MemoryContent content={record.content} />
        </div>

        {/* Metadata section */}
        <div className="mt-8 grid grid-cols-2 gap-4 rounded-xl border border-slate-800 bg-surface-dark p-4 sm:grid-cols-3">
          <MetadataItem icon={typeIcon(record.type)} label="Type" value={typeLabel(record.type)} />
          <MetadataItem icon="star" label="Importance" value={importanceStars(record.importance)} />
          <MetadataItem
            icon="speed"
            label="Confidence"
            value={`${Math.round(record.confidence * 100)}%`}
          />
          <MetadataItem icon="visibility" label="Access Count" value={String(record.accessCount)} />
          <MetadataItem
            icon="schedule"
            label="Last Accessed"
            value={relativeTimeFromEpoch(record.lastAccessedAt)}
          />
          {record.tags.length > 0 && (
            <div className="col-span-2 sm:col-span-1">
              <p className="mb-1 text-xs text-slate-500">Tags</p>
              <div className="flex flex-wrap gap-1">
                {record.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* People & Projects */}
        {(record.people.length > 0 || record.projects.length > 0) && (
          <div className="mt-4 flex flex-wrap gap-4">
            {record.people.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-slate-500">People</p>
                <div className="flex flex-wrap gap-1">
                  {record.people.map((p) => (
                    <span
                      key={p}
                      className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {record.projects.length > 0 && (
              <div>
                <p className="mb-1 text-xs text-slate-500">Projects</p>
                <div className="flex flex-wrap gap-1">
                  {record.projects.map((p) => (
                    <span
                      key={p}
                      className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Related memories */}
      {relatedRecords && relatedRecords.length > 0 && (
        <div className="border-t border-slate-800">
          <RelatedPanel records={relatedRecords} onSelect={onSelectRelated} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetadataItem({
  icon,
  label,
  value,
}: {
  icon: string
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div>
      <p className="mb-1 flex items-center gap-1 text-xs text-slate-500">
        <span className="material-symbols-outlined text-sm">{icon}</span>
        {label}
      </p>
      <p className="text-sm font-medium text-slate-200">{value}</p>
    </div>
  )
}

function MemoryContent({ content }: { content: string }): React.JSX.Element {
  // Split content into paragraphs and render with basic formatting
  const paragraphs = content.split("\n\n").filter(Boolean)

  return (
    <>
      {paragraphs.map((paragraph, i) => {
        const trimmed = paragraph.trim()

        // Code block detection
        if (trimmed.startsWith("```")) {
          const lines = trimmed.split("\n")
          const langLine = lines[0]?.replace("```", "").trim() ?? ""
          const code = lines.slice(1, -1).join("\n")
          return (
            <div key={i} className="my-4 overflow-hidden rounded-lg">
              {langLine && (
                <div className="flex items-center justify-between bg-chrome-code-header px-4 py-2 text-xs text-slate-400">
                  <span>{langLine}</span>
                </div>
              )}
              <pre className="overflow-x-auto bg-chrome-code-bg p-4">
                <code className="text-sm text-slate-300">{code}</code>
              </pre>
            </div>
          )
        }

        // Heading detection
        if (trimmed.startsWith("# ")) {
          return (
            <h3 key={i} className="mb-2 mt-6 text-lg font-bold text-slate-100">
              {trimmed.slice(2)}
            </h3>
          )
        }
        if (trimmed.startsWith("## ")) {
          return (
            <h4 key={i} className="mb-2 mt-4 text-base font-bold text-slate-200">
              {trimmed.slice(3)}
            </h4>
          )
        }

        // Callout / blockquote detection
        if (trimmed.startsWith("> ")) {
          return (
            <div
              key={i}
              className="my-3 rounded-lg border-l-4 border-primary/40 bg-primary/5 px-4 py-3"
            >
              <p className="text-sm text-slate-300">{trimmed.slice(2)}</p>
            </div>
          )
        }

        // Regular paragraph
        return (
          <p key={i} className="mb-3 text-sm leading-relaxed text-slate-300">
            {trimmed}
          </p>
        )
      })}
    </>
  )
}

/** Extract a title-like line from memory content. */
function extractTitle(content: string): string {
  const firstLine = content.split("\n")[0] ?? content
  const cleaned = firstLine.replace(/^#+\s*/, "").trim()
  return cleaned.length > 80 ? cleaned.substring(0, 80) + "..." : cleaned
}
