import { describe, expect, it } from "vitest"

import {
  AgentCostResponseSchema,
  AgentEventListResponseSchema,
  AgentEventSchema,
  AgentEventTypeSchema,
  CostSummarySchema,
  DryRunResponseSchema,
  KillResponseSchema,
  QuarantineResponseSchema,
  ReleaseResponseSchema,
  ReplayResponseSchema,
} from "@/lib/schemas/operations"

// ---------------------------------------------------------------------------
// AgentEventType
// ---------------------------------------------------------------------------

describe("AgentEventTypeSchema", () => {
  it("accepts known event types", () => {
    const types = [
      "llm_call_start",
      "llm_call_end",
      "tool_call_start",
      "tool_call_end",
      "state_transition",
      "kill_requested",
      "error",
    ]
    for (const t of types) {
      expect(AgentEventTypeSchema.parse(t)).toBe(t)
    }
  })

  it("rejects unknown event type", () => {
    expect(() => AgentEventTypeSchema.parse("invalid_type")).toThrow()
  })
})

// ---------------------------------------------------------------------------
// AgentEvent
// ---------------------------------------------------------------------------

describe("AgentEventSchema", () => {
  const validEvent = {
    id: "evt-001",
    agentId: "agt-001",
    eventType: "llm_call_end",
    payload: { model: "claude-3-opus", content: "hello" },
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.003,
    toolRef: null,
    createdAt: "2026-03-01T00:00:00Z",
  }

  it("accepts valid event", () => {
    expect(AgentEventSchema.parse(validEvent)).toEqual(validEvent)
  })

  it("accepts null token and cost values", () => {
    const event = { ...validEvent, tokensIn: null, tokensOut: null, costUsd: null }
    expect(AgentEventSchema.parse(event).tokensIn).toBeNull()
  })

  it("accepts tool_ref", () => {
    const event = { ...validEvent, toolRef: "web_search" }
    expect(AgentEventSchema.parse(event).toolRef).toBe("web_search")
  })

  it("rejects missing required fields", () => {
    expect(() => AgentEventSchema.parse({ id: "e1" })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// CostSummary
// ---------------------------------------------------------------------------

describe("CostSummarySchema", () => {
  it("accepts valid cost summary", () => {
    const data = { totalUsd: 1.25, tokensIn: 10000, tokensOut: 5000 }
    expect(CostSummarySchema.parse(data)).toEqual(data)
  })

  it("rejects missing fields", () => {
    expect(() => CostSummarySchema.parse({ totalUsd: 1.0 })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// AgentEventListResponse
// ---------------------------------------------------------------------------

describe("AgentEventListResponseSchema", () => {
  it("accepts valid response with events and cost summary", () => {
    const data = {
      events: [
        {
          id: "evt-001",
          agentId: "agt-001",
          eventType: "llm_call_end",
          payload: {},
          tokensIn: 100,
          tokensOut: 50,
          costUsd: 0.003,
          toolRef: null,
          createdAt: "2026-03-01T00:00:00Z",
        },
      ],
      total: 1,
      costSummary: { totalUsd: 0.003, tokensIn: 100, tokensOut: 50 },
    }
    const result = AgentEventListResponseSchema.parse(data)
    expect(result.events).toHaveLength(1)
    expect(result.total).toBe(1)
    expect(result.costSummary.totalUsd).toBe(0.003)
  })

  it("accepts empty events list", () => {
    const data = {
      events: [],
      total: 0,
      costSummary: { totalUsd: 0, tokensIn: 0, tokensOut: 0 },
    }
    expect(AgentEventListResponseSchema.parse(data).events).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AgentCostResponse
// ---------------------------------------------------------------------------

describe("AgentCostResponseSchema", () => {
  it("accepts cost response with model breakdown", () => {
    const data = {
      summary: { totalUsd: 5.0, tokensIn: 100000, tokensOut: 50000 },
      breakdown: [
        { model: "claude-3-opus", costUsd: 3.0, tokensIn: 60000, tokensOut: 30000 },
        { model: "claude-3-haiku", costUsd: 2.0, tokensIn: 40000, tokensOut: 20000 },
      ],
    }
    const result = AgentCostResponseSchema.parse(data)
    expect(result.breakdown).toHaveLength(2)
    expect(result.summary.totalUsd).toBe(5.0)
  })

  it("accepts empty breakdown", () => {
    const data = {
      summary: { totalUsd: 0, tokensIn: 0, tokensOut: 0 },
      breakdown: [],
    }
    expect(AgentCostResponseSchema.parse(data).breakdown).toHaveLength(0)
  })

  it("accepts day-based breakdown with extra key", () => {
    const data = {
      summary: { totalUsd: 1.0, tokensIn: 1000, tokensOut: 500 },
      breakdown: [
        { day: "2026-03-01", costUsd: 0.5, tokensIn: 500, tokensOut: 250 },
        { day: "2026-03-02", costUsd: 0.5, tokensIn: 500, tokensOut: 250 },
      ],
    }
    expect(AgentCostResponseSchema.parse(data).breakdown).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Kill / DryRun / Replay / Quarantine / Release responses
// ---------------------------------------------------------------------------

describe("KillResponseSchema", () => {
  it("accepts valid kill response", () => {
    const data = {
      agentId: "agt-001",
      previousState: "ACTIVE",
      cancelledJobId: "job-001",
      state: "QUARANTINED",
      killedAt: "2026-03-01T00:00:00Z",
    }
    expect(KillResponseSchema.parse(data).state).toBe("QUARANTINED")
  })

  it("accepts null cancelled job", () => {
    const data = {
      agentId: "agt-001",
      previousState: "ACTIVE",
      cancelledJobId: null,
      state: "QUARANTINED",
      killedAt: "2026-03-01T00:00:00Z",
    }
    expect(KillResponseSchema.parse(data).cancelledJobId).toBeNull()
  })
})

describe("DryRunResponseSchema", () => {
  it("accepts valid dry run response", () => {
    const data = {
      plannedActions: [{ type: "tool_call", toolRef: "web_search", input: { query: "test" } }],
      agentResponse: "I would search for...",
      tokensUsed: { in: 200, out: 100 },
      estimatedCostUsd: 0.005,
    }
    const result = DryRunResponseSchema.parse(data)
    expect(result.plannedActions).toHaveLength(1)
    expect(result.agentResponse).toBe("I would search for...")
  })

  it("accepts empty planned actions", () => {
    const data = {
      plannedActions: [],
      agentResponse: "No actions needed.",
      tokensUsed: { in: 50, out: 30 },
      estimatedCostUsd: 0.001,
    }
    expect(DryRunResponseSchema.parse(data).plannedActions).toHaveLength(0)
  })
})

describe("ReplayResponseSchema", () => {
  it("accepts valid replay response", () => {
    const data = {
      replayJobId: "job-002",
      fromCheckpoint: "cp-001",
      modifications: { model: "claude-3-haiku" },
    }
    expect(ReplayResponseSchema.parse(data).replayJobId).toBe("job-002")
  })

  it("accepts null modifications", () => {
    const data = {
      replayJobId: "job-002",
      fromCheckpoint: "cp-001",
      modifications: null,
    }
    expect(ReplayResponseSchema.parse(data).modifications).toBeNull()
  })
})

describe("QuarantineResponseSchema", () => {
  it("accepts valid quarantine response", () => {
    const data = {
      agentId: "agt-001",
      state: "QUARANTINED" as const,
      reason: "Manual quarantine",
      quarantinedAt: "2026-03-01T00:00:00Z",
    }
    expect(QuarantineResponseSchema.parse(data).state).toBe("QUARANTINED")
  })

  it("rejects wrong state value", () => {
    expect(() =>
      QuarantineResponseSchema.parse({
        agentId: "agt-001",
        state: "ACTIVE",
        reason: "test",
        quarantinedAt: "2026-03-01T00:00:00Z",
      }),
    ).toThrow()
  })
})

describe("ReleaseResponseSchema", () => {
  it("accepts valid release response", () => {
    const data = {
      agentId: "agt-001",
      state: "DRAINING",
      releasedAt: "2026-03-01T00:00:00Z",
    }
    expect(ReleaseResponseSchema.parse(data).state).toBe("DRAINING")
  })

  it("rejects missing fields", () => {
    expect(() => ReleaseResponseSchema.parse({ agentId: "a1" })).toThrow()
  })
})
