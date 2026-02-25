"use client"

import { relativeTime, truncateUuid } from "@/lib/format"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string
  type: "approved" | "rejected" | "requested" | "expired" | "policy_update" | "context_requested"
  actor: string
  timestamp: string
  reason?: string
  tokenHash?: string
  ipAddress?: string
  channel?: string
}

interface AuditDrawerProps {
  entries: AuditEntry[]
  onClose?: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dotConfig(type: AuditEntry["type"]): { color: string; ring: string; icon: string } {
  switch (type) {
    case "approved":
      return {
        color: "bg-green-500",
        ring: "ring-green-500/20 group-hover:ring-green-500/40",
        icon: "check_circle",
      }
    case "rejected":
      return {
        color: "bg-red-500",
        ring: "ring-red-500/20 group-hover:ring-red-500/40",
        icon: "cancel",
      }
    case "requested":
      return {
        color: "bg-blue-500",
        ring: "ring-blue-500/20 group-hover:ring-blue-500/40",
        icon: "add_circle",
      }
    case "expired":
      return {
        color: "bg-amber-500",
        ring: "ring-amber-500/20 group-hover:ring-amber-500/40",
        icon: "schedule",
      }
    case "context_requested":
      return {
        color: "bg-purple-500",
        ring: "ring-purple-500/20 group-hover:ring-purple-500/40",
        icon: "help",
      }
    case "policy_update":
    default:
      return {
        color: "bg-slate-300 dark:bg-slate-600",
        ring: "",
        icon: "policy",
      }
  }
}

function eventTitle(type: AuditEntry["type"]): string {
  switch (type) {
    case "approved":
      return "Request Approved"
    case "rejected":
      return "Auto-Rejection"
    case "requested":
      return "New Request"
    case "expired":
      return "Request Expired"
    case "context_requested":
      return "Context Requested"
    case "policy_update":
      return "Policy Update"
    default:
      return "Event"
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AuditDrawer({ entries, onClose }: AuditDrawerProps): React.JSX.Element {
  return (
    <aside className="hidden w-96 flex-shrink-0 flex-col border-l border-slate-200 bg-surface-light shadow-xl dark:border-slate-800 dark:bg-surface-dark xl:flex">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-surface-light p-5 dark:border-slate-800 dark:bg-surface-dark">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[20px] text-primary">history</span>
          <h2 className="text-base font-bold text-text-main dark:text-white">Audit Log</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="flex size-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-light dark:hover:bg-white/5"
            title="Download log"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex size-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-bg-light dark:hover:bg-white/5"
              title="Close"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto p-5 scrollbar-hide">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <span className="material-symbols-outlined mb-2 text-4xl text-slate-300 dark:text-slate-600">
              history
            </span>
            <p className="text-sm text-text-muted">No audit events yet.</p>
          </div>
        ) : (
          <div className="relative space-y-8 pl-2">
            {/* Gradient vertical line */}
            <div className="absolute bottom-2 left-[9px] top-2 w-px bg-gradient-to-b from-transparent via-slate-200 to-transparent dark:via-slate-700" />

            {entries.map((entry) => {
              const dot = dotConfig(entry.type)
              return (
                <div key={entry.id} className="group relative pl-6">
                  {/* Timeline dot */}
                  <div
                    className={`absolute -left-[5px] top-1.5 size-3 rounded-full border-2 border-white shadow-sm transition-all dark:border-surface-dark ${dot.color} ${dot.ring ? `ring-2 ${dot.ring}` : ""}`}
                  />

                  {/* Header */}
                  <div className="flex items-start justify-between">
                    <span className="text-xs font-bold text-text-main dark:text-white">
                      {eventTitle(entry.type)}
                    </span>
                    <span className="rounded bg-bg-light px-1.5 py-0.5 font-mono text-[10px] text-text-muted dark:bg-bg-dark">
                      {relativeTime(entry.timestamp)}
                    </span>
                  </div>

                  {/* Body */}
                  <p className="mt-1 text-sm leading-snug text-text-muted">
                    <span className="font-bold text-text-main dark:text-white">{entry.actor}</span>
                    {entry.type === "approved" && " approved this request"}
                    {entry.type === "rejected" && " rejected this request"}
                    {entry.type === "requested" && " submitted this request"}
                    {entry.type === "expired" && " — request expired automatically"}
                    {entry.type === "context_requested" && " requested more context"}
                    {entry.type === "policy_update" && " updated the approval policy"}
                    {entry.channel && <span className="text-text-muted"> via {entry.channel}</span>}
                  </p>

                  {/* Reason quote */}
                  {entry.reason && (
                    <div className="relative mt-2 rounded-lg border border-slate-200 bg-bg-light p-2.5 text-xs italic text-text-muted dark:border-slate-700 dark:bg-bg-dark">
                      <div className="absolute -top-1 left-3 size-2 rotate-45 border-l border-t border-slate-200 bg-bg-light dark:border-slate-700 dark:bg-bg-dark" />
                      &ldquo;{entry.reason}&rdquo;
                    </div>
                  )}

                  {/* Metadata */}
                  {(entry.tokenHash || entry.ipAddress) && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {entry.tokenHash && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          Token: {truncateUuid(entry.tokenHash)}
                        </span>
                      )}
                      {entry.ipAddress && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          IP: {entry.ipAddress}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-slate-200 p-4 dark:border-slate-800">
        <button
          type="button"
          className="w-full rounded-lg border border-slate-200 bg-surface-light py-2.5 text-xs font-bold uppercase tracking-wider text-text-main shadow-sm transition-colors hover:bg-bg-light dark:border-slate-700 dark:bg-surface-dark dark:text-white dark:hover:bg-white/5"
        >
          View Full Logs
        </button>
      </div>
    </aside>
  )
}
