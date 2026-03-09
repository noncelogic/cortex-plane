/**
 * Tests for operations page auto-refresh behavior (issue #511).
 *
 * The pages use a canonical SSE-triggered refetch pattern:
 *   1. Track event count with a ref
 *   2. When events.length > prevCount, refetch() and update ref
 *
 * We test this pattern directly (without React rendering) since the
 * hooks are thin wrappers tested elsewhere.
 */

import { describe, expect, it, vi } from "vitest"

import type { ApprovalEventPayload } from "@/hooks/use-approval-stream"

// ---------------------------------------------------------------------------
// SSE-triggered refetch pattern (mirrors page implementation)
// ---------------------------------------------------------------------------

/**
 * Simulates the useEffect pattern used by both operations pages:
 *   if (events.length > prevCount) { prevCount = events.length; refetch() }
 */
function simulateRefetchOnEvents(eventCounts: number[], refetch: () => void): void {
  let prevCount = 0
  for (const count of eventCounts) {
    if (count > prevCount) {
      prevCount = count
      refetch()
    }
  }
}

describe("SSE-triggered auto-refresh pattern", () => {
  it("refetches when new events arrive", () => {
    const refetch = vi.fn()
    // Simulate: mount with 0 events, then 1, then 2, then 3 arrive
    simulateRefetchOnEvents([0, 1, 2, 3], refetch)
    expect(refetch).toHaveBeenCalledTimes(3)
  })

  it("does not refetch when event count stays the same", () => {
    const refetch = vi.fn()
    // Simulate: same count across multiple renders
    simulateRefetchOnEvents([0, 0, 0], refetch)
    expect(refetch).toHaveBeenCalledTimes(0)
  })

  it("does not refetch on initial mount with zero events", () => {
    const refetch = vi.fn()
    simulateRefetchOnEvents([0], refetch)
    expect(refetch).toHaveBeenCalledTimes(0)
  })

  it("handles burst of events (count jumps)", () => {
    const refetch = vi.fn()
    // Simulate: 0 events, then suddenly 5
    simulateRefetchOnEvents([0, 5], refetch)
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it("refetches again after a quiet period then new events", () => {
    const refetch = vi.fn()
    // 0 -> 3 (refetch), 3 -> 3 (no-op), 3 -> 5 (refetch)
    simulateRefetchOnEvents([0, 3, 3, 3, 5], refetch)
    expect(refetch).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Approval toast logic (mirrors page implementation)
// ---------------------------------------------------------------------------

function simulateApprovalToasts(
  events: ApprovalEventPayload[],
  agentId?: string,
): { warnings: string[]; infos: string[] } {
  const warnings: string[] = []
  const infos: string[] = []

  let prevCount = 0
  // Simulate a single "render" with all events
  if (events.length > prevCount) {
    const newEvents = events.slice(prevCount)
    prevCount = events.length
    for (const evt of newEvents) {
      if (evt.type === "created") {
        // Fleet page shows all; agent page filters by agent_id
        if (!agentId || evt.data.agent_id === agentId) {
          warnings.push(`Approval required: ${evt.data.action_summary}`)
        }
      } else if (evt.type === "decided") {
        if (!agentId) {
          // fleet page doesn't toast on decisions
        } else {
          infos.push(`Approval ${evt.data.decision.toLowerCase()}`)
        }
      }
    }
  }

  return { warnings, infos }
}

describe("Approval notification toasts", () => {
  it("shows warning toast for new approval (fleet page)", () => {
    const events: ApprovalEventPayload[] = [
      {
        type: "created",
        data: {
          approval_request_id: "apr-1",
          job_id: "job-1",
          agent_id: "agt-1",
          action_summary: "Delete user records",
          action_type: "destructive",
          expires_at: "2026-03-10T00:00:00Z",
          timestamp: "2026-03-09T12:00:00Z",
        },
      },
    ]
    const result = simulateApprovalToasts(events)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toBe("Approval required: Delete user records")
  })

  it("shows toast only for matching agent on agent page", () => {
    const events: ApprovalEventPayload[] = [
      {
        type: "created",
        data: {
          approval_request_id: "apr-1",
          job_id: "job-1",
          agent_id: "agt-1",
          action_summary: "Delete records",
          action_type: "destructive",
          expires_at: "2026-03-10T00:00:00Z",
          timestamp: "2026-03-09T12:00:00Z",
        },
      },
      {
        type: "created",
        data: {
          approval_request_id: "apr-2",
          job_id: "job-2",
          agent_id: "agt-2",
          action_summary: "Send email",
          action_type: "external",
          expires_at: "2026-03-10T00:00:00Z",
          timestamp: "2026-03-09T12:01:00Z",
        },
      },
    ]

    const result = simulateApprovalToasts(events, "agt-1")
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toBe("Approval required: Delete records")
  })

  it("shows info toast for decided approvals on agent page", () => {
    const events: ApprovalEventPayload[] = [
      {
        type: "decided",
        data: {
          approval_request_id: "apr-1",
          job_id: "job-1",
          decision: "APPROVED",
          decided_by: "admin",
          timestamp: "2026-03-09T12:05:00Z",
        },
      },
    ]
    const result = simulateApprovalToasts(events, "agt-1")
    expect(result.infos).toHaveLength(1)
    expect(result.infos[0]).toBe("Approval approved")
  })

  it("no toasts when no events arrive", () => {
    const result = simulateApprovalToasts([])
    expect(result.warnings).toHaveLength(0)
    expect(result.infos).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Fleet stats derivation (mirrors operations page)
// ---------------------------------------------------------------------------

interface AgentSummaryLike {
  lifecycle_state?: string
  status?: string
}

function deriveFleetStats(agents: AgentSummaryLike[]) {
  let executing = 0
  let ready = 0
  let quarantined = 0
  let other = 0
  for (const a of agents) {
    const s = a.lifecycle_state
    if (s === "EXECUTING") executing++
    else if (s === "READY") ready++
    else if (a.status === "ARCHIVED" || a.status === "DISABLED") quarantined++
    else other++
  }
  return { total: agents.length, executing, ready, quarantined, other }
}

describe("Fleet stats update on agent list refetch", () => {
  it("reflects executing count change after refetch", () => {
    const before = deriveFleetStats([{ lifecycle_state: "READY" }, { lifecycle_state: "READY" }])
    expect(before.executing).toBe(0)
    expect(before.ready).toBe(2)

    // After refetch, one agent switched to EXECUTING
    const after = deriveFleetStats([{ lifecycle_state: "EXECUTING" }, { lifecycle_state: "READY" }])
    expect(after.executing).toBe(1)
    expect(after.ready).toBe(1)
  })

  it("reflects quarantine after agent status change", () => {
    const before = deriveFleetStats([{ lifecycle_state: "READY" }])
    expect(before.quarantined).toBe(0)

    const after = deriveFleetStats([{ status: "ARCHIVED" }])
    expect(after.quarantined).toBe(1)
    expect(after.ready).toBe(0)
  })
})
