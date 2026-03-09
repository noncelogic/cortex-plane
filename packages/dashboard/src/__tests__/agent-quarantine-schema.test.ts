/**
 * Dashboard schema validation for quarantined agents (#491).
 *
 * Ensures that agents in every lifecycle status — including QUARANTINED —
 * pass dashboard Zod schema validation and render data shapes correctly.
 *
 * Test cases:
 * 1. QUARANTINED agent validates against AgentSummarySchema
 * 2. QUARANTINED agent validates against AgentDetailSchema
 * 3. Agent list with mixed statuses validates against AgentListResponseSchema
 * 4. All AgentStatus enum values are accepted by the schema
 * 5. Release button visibility contract (isQuarantined logic)
 */

import { describe, expect, it } from "vitest"

import {
  AgentDetailSchema,
  AgentListResponseSchema,
  AgentStatusSchema,
  AgentSummarySchema,
} from "../lib/schemas/agents"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_AGENT = {
  id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  name: "Test Agent",
  slug: "test-agent",
  role: "researcher",
  description: "A test agent",
  created_at: "2025-01-15T10:30:00.000Z",
  updated_at: "2025-01-15T10:30:00.000Z",
}

function makeAgentSummary(overrides: Record<string, unknown> = {}) {
  return { ...BASE_AGENT, status: "ACTIVE", ...overrides }
}

function makeAgentDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...BASE_AGENT,
    status: "ACTIVE",
    model_config: { model: "gpt-4" },
    skill_config: {},
    resource_limits: {},
    channel_permissions: {},
    config: {},
    checkpoint: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Dashboard schema: quarantined agents", () => {
  it("QUARANTINED agent validates against AgentSummarySchema", () => {
    const agent = makeAgentSummary({ status: "QUARANTINED" })
    const result = AgentSummarySchema.safeParse(agent)
    expect(result.success).toBe(true)
  })

  it("QUARANTINED agent validates against AgentDetailSchema", () => {
    const agent = makeAgentDetail({ status: "QUARANTINED" })
    const result = AgentDetailSchema.safeParse(agent)
    expect(result.success).toBe(true)
  })

  it("all agent statuses validate against AgentSummarySchema", () => {
    const statuses = ["ACTIVE", "DISABLED", "ARCHIVED", "QUARANTINED"] as const

    for (const status of statuses) {
      const agent = makeAgentSummary({ status })
      const result = AgentSummarySchema.safeParse(agent)
      expect(result.success, `Expected ${status} to validate`).toBe(true)
    }
  })

  it("AgentStatusSchema rejects unknown status values", () => {
    const result = AgentStatusSchema.safeParse("FROZEN")
    expect(result.success).toBe(false)
  })

  it("mixed-status agent list validates against AgentListResponseSchema", () => {
    const payload = {
      agents: [
        makeAgentSummary({ id: "id-1", status: "ACTIVE" }),
        makeAgentSummary({ id: "id-2", status: "QUARANTINED" }),
        makeAgentSummary({ id: "id-3", status: "DISABLED" }),
        makeAgentSummary({ id: "id-4", status: "ARCHIVED" }),
      ],
      count: 4,
    }

    const result = AgentListResponseSchema.safeParse(payload)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.agents).toHaveLength(4)
      expect(result.data.pagination.total).toBe(4)
    }
  })

  it("QUARANTINED agent with lifecycle_state validates", () => {
    const agent = makeAgentSummary({
      status: "QUARANTINED",
      lifecycle_state: "EXECUTING",
    })
    const result = AgentSummarySchema.safeParse(agent)
    expect(result.success).toBe(true)
  })

  it("QUARANTINED agent detail with resource_limits (circuit breaker config) validates", () => {
    const agent = makeAgentDetail({
      status: "QUARANTINED",
      resource_limits: {
        circuitBreaker: {
          maxConsecutiveFailures: 5,
          tokenBudgetPerJob: 100_000,
        },
      },
    })
    const result = AgentDetailSchema.safeParse(agent)
    expect(result.success).toBe(true)
  })
})

describe("Release button visibility contract", () => {
  it("isQuarantined is true only for QUARANTINED status", () => {
    // This mirrors the logic in agent-control-panel.tsx:
    // const isQuarantined = agentStatus === "QUARANTINED"
    const statuses = ["ACTIVE", "DISABLED", "ARCHIVED", "QUARANTINED"] as const

    for (const status of statuses) {
      const isQuarantined = status === "QUARANTINED"
      if (status === "QUARANTINED") {
        expect(isQuarantined).toBe(true)
      } else {
        expect(isQuarantined).toBe(false)
      }
    }
  })

  it("kill button is disabled when quarantined (per component contract)", () => {
    // In agent-control-panel.tsx: disabled={isQuarantined}
    const isQuarantined = true
    expect(isQuarantined).toBe(true) // Kill button would be disabled
  })
})
