"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"

import type { ApprovalRequest } from "@/lib/api-client"

import { RiskBadge } from "./risk-badge"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskLevel = "CRITICAL" | "MEDIUM" | "LOW"

interface ApprovalCardProps {
  approval: ApprovalRequest
  onSelect?: (id: string) => void
  selected?: boolean
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
  onRequestContext?: (id: string) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyRisk(approval: ApprovalRequest): RiskLevel {
  const t = approval.action_type.toLowerCase()
  if (t.includes("delete") || t.includes("deploy") || t.includes("prod")) return "CRITICAL"
  if (t.includes("scale") || t.includes("update") || t.includes("modify")) return "MEDIUM"
  return "LOW"
}

function riskBarColor(level: RiskLevel): string {
  if (level === "CRITICAL") return "bg-red-500"
  if (level === "MEDIUM") return "bg-amber-500"
  return "bg-blue-500"
}

function riskIconBg(level: RiskLevel): string {
  if (level === "CRITICAL") return "bg-red-500/10"
  if (level === "MEDIUM") return "bg-amber-500/10"
  return "bg-blue-500/10"
}

function riskIconColor(level: RiskLevel): string {
  if (level === "CRITICAL") return "text-red-500"
  if (level === "MEDIUM") return "text-amber-500"
  return "text-blue-500"
}

function riskIcon(level: RiskLevel): string {
  if (level === "CRITICAL") return "gpp_maybe"
  if (level === "MEDIUM") return "warning"
  return "info"
}

function getInitials(name: string): string {
  return name
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
}

/** Derive tags from the approval action detail / type. */
function deriveTags(
  approval: ApprovalRequest,
): { label: string; icon?: string; variant: string }[] {
  const tags: { label: string; icon?: string; variant: string }[] = []
  const t = approval.action_type.toLowerCase()
  const detail = approval.action_detail ?? {}

  if (t.includes("kubernetes") || t.includes("k8s") || detail.platform === "kubernetes") {
    tags.push({ label: "Kubernetes", icon: "dns", variant: "default" })
  }
  if (t.includes("prod") || detail.environment === "production") {
    tags.push({ label: "Prod-US-East", icon: "public", variant: "default" })
  }
  if (t.includes("deploy") || t.includes("infrastructure")) {
    tags.push({ label: "Infrastructure", icon: "settings_ethernet", variant: "default" })
  }
  if (detail.aiGenerated || t.includes("ai")) {
    tags.push({ label: "AI Generated Code", icon: "auto_awesome", variant: "purple" })
  }
  if (detail.externalAccess || t.includes("external")) {
    tags.push({ label: "External Access", icon: "public_off", variant: "danger" })
  }
  if (t.includes("security") || t.includes("shield")) {
    tags.push({ label: "Security", icon: "shield", variant: "default" })
  }
  if (t.includes("billing") || t.includes("cost")) {
    tags.push({ label: "Billing", icon: "attach_money", variant: "default" })
  }

  // Always have at least one tag from the action type
  if (tags.length === 0) {
    tags.push({ label: approval.action_type, variant: "default" })
  }

  return tags
}

const tagVariants: Record<string, string> = {
  default: "bg-secondary text-text-muted border-surface-border",
  purple: "bg-purple-500/10 text-purple-500 border-purple-500/20",
  danger: "bg-red-500/10 text-red-500 border-red-500/20",
}

// ---------------------------------------------------------------------------
// Countdown hook
// ---------------------------------------------------------------------------

function useCountdown(expiresAt: string): { display: string; expired: boolean; urgent: boolean } {
  const compute = useCallback(() => {
    const diff = new Date(expiresAt).getTime() - Date.now()
    if (diff <= 0) return { display: "00:00", expired: true, urgent: true }

    const hours = Math.floor(diff / 3_600_000)
    const minutes = Math.floor((diff % 3_600_000) / 60_000)
    const seconds = Math.floor((diff % 60_000) / 1_000)

    const parts: string[] = []
    if (hours > 0) parts.push(String(hours).padStart(2, "0"))
    parts.push(String(minutes).padStart(2, "0"))
    parts.push(String(seconds).padStart(2, "0"))

    return {
      display: parts.join(":"),
      expired: false,
      urgent: diff < 300_000, // less than 5 minutes
    }
  }, [expiresAt])

  const [state, setState] = useState(compute)
  const intervalRef = useRef<ReturnType<typeof setInterval>>(null)

  useEffect(() => {
    setState(compute())
    intervalRef.current = setInterval(() => setState(compute()), 1_000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [compute])

  return state
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApprovalCard({
  approval,
  onSelect,
  selected,
  onApprove,
  onReject,
  onRequestContext,
}: ApprovalCardProps): React.JSX.Element {
  const risk = classifyRisk(approval)
  const { display: countdown, expired, urgent } = useCountdown(approval.expires_at)
  const tags = deriveTags(approval)
  const isPending = approval.status === "PENDING"
  const agentName = approval.requested_by_agent_id ?? "Unknown Agent"

  return (
    <div
      className={`group relative flex flex-col overflow-hidden rounded-xl border shadow-sm transition-all duration-200 hover:shadow-md ${
        selected ? "border-primary/50 shadow-md" : "border-surface-border hover:border-primary/50"
      } bg-surface-light`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(approval.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect?.(approval.id)
      }}
    >
      {/* Left risk indicator bar */}
      <div className={`absolute left-0 top-0 h-full w-1 ${riskBarColor(risk)}`} />

      {/* Card body */}
      <div className="flex gap-5 p-5 pl-6">
        {/* Risk icon circle */}
        <div className="mt-1 flex-shrink-0">
          <div
            className={`flex size-10 items-center justify-center rounded-full ${riskIconBg(risk)}`}
          >
            <span className={`material-symbols-outlined text-[20px] ${riskIconColor(risk)}`}>
              {riskIcon(risk)}
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          {/* Header: risk label + request ID + timer */}
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <RiskBadge level={risk} />
            <span className="font-mono text-xs text-text-muted">#{approval.id.slice(0, 8)}</span>
            <div className="ml-auto flex-shrink-0">
              <div
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 ${
                  risk === "CRITICAL" || urgent
                    ? "border-red-500/20 bg-red-500/10"
                    : "border-surface-border bg-bg-light"
                }`}
              >
                <span
                  className={`material-symbols-outlined text-[16px] ${
                    risk === "CRITICAL" || urgent ? "text-red-500" : "text-text-muted"
                  }`}
                >
                  timer
                </span>
                {(risk === "CRITICAL" || urgent) && (
                  <span className="text-[10px] font-bold uppercase text-red-500">Expires</span>
                )}
                <span
                  className={`font-mono text-sm font-bold ${
                    expired
                      ? "text-red-500"
                      : risk === "CRITICAL" || urgent
                        ? "text-red-500"
                        : "text-text-main"
                  }`}
                >
                  {expired ? "EXPIRED" : countdown}
                </span>
              </div>
            </div>
          </div>

          {/* Title */}
          <h3 className="truncate text-lg font-bold text-text-main">{approval.action_summary}</h3>

          {/* Description */}
          {typeof approval.action_detail?.description === "string" && (
            <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-text-muted">
              {approval.action_detail.description}
            </p>
          )}

          {/* Tags */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag.label}
                className={`flex items-center gap-1 rounded border px-2.5 py-1 text-xs font-medium ${tagVariants[tag.variant] ?? tagVariants.default}`}
              >
                {tag.icon && (
                  <span className="material-symbols-outlined text-[14px]">{tag.icon}</span>
                )}
                {tag.label}
              </span>
            ))}
          </div>

          {/* Requester / Agent */}
          <div className="mt-3 flex items-center gap-2">
            <div className="flex size-6 items-center justify-center rounded-full bg-blue-500/10 ring-2 ring-surface-light">
              <span className="text-[10px] font-bold text-primary">{getInitials(agentName)}</span>
            </div>
            <span className="text-xs text-text-muted">
              Requested by{" "}
              {approval.requested_by_agent_id ? (
                <Link
                  href={`/agents/${approval.requested_by_agent_id}`}
                  className="font-medium text-text-main hover:text-primary"
                  onClick={(e) => e.stopPropagation()}
                >
                  {agentName}
                </Link>
              ) : (
                <span className="font-medium text-text-main">{agentName}</span>
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Card footer with actions */}
      {isPending && (
        <div className="sticky bottom-0 z-10 flex items-center justify-between border-t border-surface-border bg-surface-light/90 px-5 py-3 backdrop-blur-md">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRequestContext?.(approval.id)
            }}
            className="rounded-lg px-4 py-2 text-xs font-bold uppercase tracking-wider text-text-muted transition-colors hover:bg-secondary"
          >
            Request Context
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onReject?.(approval.id)
              }}
              className="rounded-lg px-4 py-2 text-xs font-bold uppercase tracking-wider text-red-500 transition-colors hover:bg-red-500/10"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onApprove?.(approval.id)
              }}
              className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2 text-xs font-bold uppercase tracking-wider text-white shadow-md shadow-primary/20 transition-all hover:bg-primary/90 active:scale-95"
            >
              <span className="material-symbols-outlined text-[16px]">check_circle</span>
              Approve
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
