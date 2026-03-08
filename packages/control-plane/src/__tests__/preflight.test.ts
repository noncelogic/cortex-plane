import type { Kysely } from "kysely"
import { afterEach, describe, expect, it, vi } from "vitest"

import { mapJobErrorToUserMessage, runPreflight } from "../channels/preflight.js"
import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

function selectChain(rows: Record<string, unknown>[]) {
  const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? null)
  const terminal = { executeTakeFirst }
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, ...terminal })
  const selectFn = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
  return { selectFn, whereFn }
}

function joinChain(rows: Record<string, unknown>[]) {
  const executeTakeFirst = vi.fn().mockResolvedValue(rows[0] ?? null)
  const terminal = { executeTakeFirst }
  const whereFn: ReturnType<typeof vi.fn> = vi.fn()
  whereFn.mockReturnValue({ where: whereFn, ...terminal })
  const selectFn = vi.fn().mockReturnValue({ where: whereFn, ...terminal })
  const innerJoinFn = vi.fn().mockReturnValue({ select: selectFn })
  return { innerJoinFn }
}

// ---------------------------------------------------------------------------
// runPreflight
// ---------------------------------------------------------------------------

describe("runPreflight", () => {
  const originalEnv = process.env.LLM_API_KEY

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.LLM_API_KEY = originalEnv
    } else {
      delete process.env.LLM_API_KEY
    }
  })

  it("returns ok when agent is ACTIVE and LLM_API_KEY env var is set", async () => {
    process.env.LLM_API_KEY = "sk-test"

    const agentSelect = selectChain([{ id: "agent-1", status: "ACTIVE" }])
    const db = {
      selectFrom: vi.fn().mockReturnValue({ select: agentSelect.selectFn }),
    } as unknown as Kysely<Database>

    const result = await runPreflight(db, "agent-1")

    expect(result).toEqual({ ok: true })
  })

  it("returns ok when agent is ACTIVE and has bound LLM credential", async () => {
    delete process.env.LLM_API_KEY

    // Agent lookup
    const agentSelect = selectChain([{ id: "agent-1", status: "ACTIVE" }])
    // Credential binding lookup
    const credJoin = joinChain([{ id: "cred-1" }])

    let callCount = 0
    const db = {
      selectFrom: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          // agent lookup
          return { select: agentSelect.selectFn }
        }
        // agent_credential_binding lookup
        return { innerJoin: credJoin.innerJoinFn }
      }),
    } as unknown as Kysely<Database>

    const result = await runPreflight(db, "agent-1")

    expect(result).toEqual({ ok: true })
  })

  it("returns not_active for QUARANTINED agent", async () => {
    const agentSelect = selectChain([{ id: "agent-1", status: "QUARANTINED" }])
    const db = {
      selectFrom: vi.fn().mockReturnValue({ select: agentSelect.selectFn }),
    } as unknown as Kysely<Database>

    const result = await runPreflight(db, "agent-1")

    expect(result.ok).toBe(false)
    expect(result.code).toBe("agent_not_active")
    expect(result.userMessage).toContain("quarantined")
    expect(result.userMessage).toContain("operator")
  })

  it("returns not_active for DISABLED agent", async () => {
    const agentSelect = selectChain([{ id: "agent-1", status: "DISABLED" }])
    const db = {
      selectFrom: vi.fn().mockReturnValue({ select: agentSelect.selectFn }),
    } as unknown as Kysely<Database>

    const result = await runPreflight(db, "agent-1")

    expect(result.ok).toBe(false)
    expect(result.code).toBe("agent_not_active")
    expect(result.userMessage).toContain("disabled")
  })

  it("returns not_active for ARCHIVED agent", async () => {
    const agentSelect = selectChain([{ id: "agent-1", status: "ARCHIVED" }])
    const db = {
      selectFrom: vi.fn().mockReturnValue({ select: agentSelect.selectFn }),
    } as unknown as Kysely<Database>

    const result = await runPreflight(db, "agent-1")

    expect(result.ok).toBe(false)
    expect(result.code).toBe("agent_not_active")
    expect(result.userMessage).toContain("archived")
  })

  it("returns not_active when agent is not found", async () => {
    const agentSelect = selectChain([])
    const db = {
      selectFrom: vi.fn().mockReturnValue({ select: agentSelect.selectFn }),
    } as unknown as Kysely<Database>

    const result = await runPreflight(db, "missing-agent")

    expect(result.ok).toBe(false)
    expect(result.code).toBe("agent_not_active")
    expect(result.userMessage).toContain("not found")
  })

  it("returns no_llm_credential when no env var and no binding", async () => {
    delete process.env.LLM_API_KEY

    // Agent lookup returns ACTIVE
    const agentSelect = selectChain([{ id: "agent-1", status: "ACTIVE" }])
    // Credential binding returns nothing
    const credJoin = joinChain([])

    let callCount = 0
    const db = {
      selectFrom: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return { select: agentSelect.selectFn }
        }
        return { innerJoin: credJoin.innerJoinFn }
      }),
    } as unknown as Kysely<Database>

    const result = await runPreflight(db, "agent-1")

    expect(result.ok).toBe(false)
    expect(result.code).toBe("no_llm_credential")
    expect(result.userMessage).toContain("LLM API key")
    expect(result.userMessage).toContain("operator")
  })
})

// ---------------------------------------------------------------------------
// mapJobErrorToUserMessage
// ---------------------------------------------------------------------------

describe("mapJobErrorToUserMessage", () => {
  it("returns quarantine message for QUARANTINED category", () => {
    const msg = mapJobErrorToUserMessage({
      category: "QUARANTINED",
      message: "Agent quarantined: too many failures",
    })
    expect(msg).toContain("quarantined")
    expect(msg).toContain("operator")
  })

  it("returns credential message when error mentions missing credential", () => {
    const msg = mapJobErrorToUserMessage({
      category: "PERMANENT",
      message:
        "No LLM credential available. Bind an OAuth credential to this agent or set LLM_API_KEY env var.",
    })
    expect(msg).toContain("LLM API key")
    expect(msg).toContain("operator")
  })

  it("returns auth failure message for expired credentials", () => {
    const msg = mapJobErrorToUserMessage({
      category: "PERMANENT",
      message: "Authentication failed",
    })
    expect(msg).toContain("invalid or expired")
  })

  it("returns context budget message for CONTEXT_BUDGET_EXCEEDED", () => {
    const msg = mapJobErrorToUserMessage({
      category: "CONTEXT_BUDGET_EXCEEDED",
      message: "Context budget exceeded",
    })
    expect(msg).toContain("context size limit")
  })

  it("returns timeout message for TIMEOUT category", () => {
    const msg = mapJobErrorToUserMessage({ category: "TIMEOUT", message: "timed out" })
    expect(msg).toContain("timed out")
  })

  it("returns generic message for unknown error", () => {
    const msg = mapJobErrorToUserMessage({ category: "UNKNOWN", message: "unexpected failure" })
    expect(msg).toContain("Something went wrong")
  })

  it("returns generic message for null/undefined error", () => {
    expect(mapJobErrorToUserMessage(null)).toContain("Something went wrong")
    expect(mapJobErrorToUserMessage(undefined)).toContain("Something went wrong")
  })
})
