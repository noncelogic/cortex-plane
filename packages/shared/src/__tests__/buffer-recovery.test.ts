import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { recoverFromBuffer } from "../buffer/recovery.js"
import type { BufferEvent } from "../buffer/types.js"
import { BufferWriter } from "../buffer/writer.js"

const JOB_ID = "test-job-recovery"

function makeEventLine(overrides: Partial<BufferEvent> = {}): string {
  const event: BufferEvent = {
    version: "1.0",
    timestamp: new Date().toISOString(),
    jobId: JOB_ID,
    sessionId: "sess-001",
    agentId: "agent-001",
    sequence: 0,
    type: "LLM_REQUEST",
    data: {},
    ...overrides,
  }
  return JSON.stringify(event)
}

function makeEvent(
  overrides: Partial<Omit<BufferEvent, "sequence">> = {},
): Omit<BufferEvent, "sequence"> {
  return {
    version: "1.0",
    timestamp: new Date().toISOString(),
    jobId: JOB_ID,
    sessionId: "sess-001",
    agentId: "agent-001",
    type: "LLM_REQUEST",
    data: {},
    ...overrides,
  }
}

describe("recoverFromBuffer", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "buffer-recovery-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns empty state when job directory does not exist", () => {
    const state = recoverFromBuffer(tempDir, "nonexistent-job")
    expect(state.lastCheckpoint).toBeNull()
    expect(state.eventsSinceCheckpoint).toEqual([])
    expect(state.sessionFile).toBe("")
  })

  it("returns empty state when job directory has no session files", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })
    writeFileSync(join(jobDir, "metadata.json"), "{}")

    const state = recoverFromBuffer(tempDir, JOB_ID)
    expect(state.lastCheckpoint).toBeNull()
    expect(state.eventsSinceCheckpoint).toEqual([])
    expect(state.sessionFile).toBe("")
  })

  it("recovers from a session with a checkpoint", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })

    writeFileSync(
      join(jobDir, "session-001.jsonl"),
      [
        makeEventLine({ sequence: 0, type: "SESSION_START" }),
        makeEventLine({ sequence: 1, type: "LLM_REQUEST" }),
        makeEventLine({ sequence: 2, type: "CHECKPOINT", data: { step: 2 } }),
        makeEventLine({ sequence: 3, type: "LLM_REQUEST" }),
        makeEventLine({ sequence: 4, type: "TOOL_CALL" }),
      ].join("\n") + "\n",
    )

    const state = recoverFromBuffer(tempDir, JOB_ID)
    expect(state.lastCheckpoint).not.toBeNull()
    expect(state.lastCheckpoint!.type).toBe("CHECKPOINT")
    expect(state.lastCheckpoint!.data).toEqual({ step: 2 })
    expect(state.eventsSinceCheckpoint).toHaveLength(2)
    expect(state.eventsSinceCheckpoint[0]!.type).toBe("LLM_REQUEST")
    expect(state.eventsSinceCheckpoint[1]!.type).toBe("TOOL_CALL")
    expect(state.sessionFile).toContain("session-001.jsonl")
  })

  it("recovers from a session with no checkpoint (all events since start)", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })

    writeFileSync(
      join(jobDir, "session-001.jsonl"),
      [
        makeEventLine({ sequence: 0, type: "SESSION_START" }),
        makeEventLine({ sequence: 1, type: "LLM_REQUEST" }),
        makeEventLine({ sequence: 2, type: "LLM_RESPONSE" }),
      ].join("\n") + "\n",
    )

    const state = recoverFromBuffer(tempDir, JOB_ID)
    expect(state.lastCheckpoint).toBeNull()
    expect(state.eventsSinceCheckpoint).toHaveLength(3)
  })

  it("uses the latest session file when multiple exist", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })

    writeFileSync(
      join(jobDir, "session-001.jsonl"),
      [
        makeEventLine({ sequence: 0, type: "SESSION_START" }),
        makeEventLine({ sequence: 1, type: "CHECKPOINT", data: { step: 1 } }),
      ].join("\n") + "\n",
    )

    writeFileSync(
      join(jobDir, "session-002.jsonl"),
      [
        makeEventLine({ sequence: 0, type: "SESSION_START" }),
        makeEventLine({ sequence: 1, type: "CHECKPOINT", data: { step: 3 } }),
        makeEventLine({ sequence: 2, type: "TOOL_RESULT", data: { tool: "deploy" } }),
      ].join("\n") + "\n",
    )

    const state = recoverFromBuffer(tempDir, JOB_ID)
    expect(state.lastCheckpoint!.data).toEqual({ step: 3 })
    expect(state.eventsSinceCheckpoint).toHaveLength(1)
    expect(state.eventsSinceCheckpoint[0]!.type).toBe("TOOL_RESULT")
    expect(state.sessionFile).toContain("session-002.jsonl")
  })

  it("finds the last checkpoint when multiple checkpoints exist", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })

    writeFileSync(
      join(jobDir, "session-001.jsonl"),
      [
        makeEventLine({ sequence: 0, type: "CHECKPOINT", data: { step: 1 } }),
        makeEventLine({ sequence: 1, type: "LLM_REQUEST" }),
        makeEventLine({ sequence: 2, type: "CHECKPOINT", data: { step: 2 } }),
        makeEventLine({ sequence: 3, type: "ERROR", data: { message: "crash" } }),
      ].join("\n") + "\n",
    )

    const state = recoverFromBuffer(tempDir, JOB_ID)
    expect(state.lastCheckpoint!.data).toEqual({ step: 2 })
    expect(state.eventsSinceCheckpoint).toHaveLength(1)
    expect(state.eventsSinceCheckpoint[0]!.type).toBe("ERROR")
  })

  it("handles truncated last line (crash mid-write)", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })

    writeFileSync(
      join(jobDir, "session-001.jsonl"),
      [
        makeEventLine({ sequence: 0, type: "SESSION_START" }),
        makeEventLine({ sequence: 1, type: "CHECKPOINT", data: { step: 1 } }),
        makeEventLine({ sequence: 2, type: "TOOL_CALL" }),
        '{"type":"TOOL_RES',
      ].join("\n"),
    )

    const state = recoverFromBuffer(tempDir, JOB_ID)
    expect(state.lastCheckpoint!.type).toBe("CHECKPOINT")
    expect(state.eventsSinceCheckpoint).toHaveLength(1)
    expect(state.eventsSinceCheckpoint[0]!.type).toBe("TOOL_CALL")
  })

  it("works end-to-end with BufferWriter output", () => {
    const writer = new BufferWriter(tempDir, JOB_ID)
    writer.append(makeEvent({ type: "SESSION_START" }))
    writer.append(makeEvent({ type: "LLM_REQUEST" }))
    writer.append(makeEvent({ type: "LLM_RESPONSE" }))
    writer.append(makeEvent({ type: "CHECKPOINT", data: { step: 1 } }))
    writer.append(makeEvent({ type: "LLM_REQUEST" }))
    writer.append(makeEvent({ type: "TOOL_CALL" }))
    writer.close()

    const state = recoverFromBuffer(tempDir, JOB_ID)
    expect(state.lastCheckpoint).not.toBeNull()
    expect(state.lastCheckpoint!.type).toBe("CHECKPOINT")
    expect(state.lastCheckpoint!.data).toEqual({ step: 1 })
    expect(state.eventsSinceCheckpoint).toHaveLength(2)
    expect(state.eventsSinceCheckpoint[0]!.type).toBe("LLM_REQUEST")
    expect(state.eventsSinceCheckpoint[1]!.type).toBe("TOOL_CALL")
  })

  it("recovers after multi-session crash scenario", () => {
    // Session 1: runs, checkpoints, crashes
    const writer1 = new BufferWriter(tempDir, JOB_ID)
    writer1.append(makeEvent({ type: "SESSION_START" }))
    writer1.append(makeEvent({ type: "CHECKPOINT", data: { step: 1 } }))
    writer1.append(makeEvent({ type: "LLM_REQUEST" }))
    writer1.close()

    // Session 2: resumes, checkpoints further, crashes mid-tool
    const writer2 = new BufferWriter(tempDir, JOB_ID)
    writer2.append(makeEvent({ type: "SESSION_START" }))
    writer2.append(makeEvent({ type: "CHECKPOINT", data: { step: 3 } }))
    writer2.append(makeEvent({ type: "TOOL_CALL", data: { tool: "deploy" } }))
    writer2.close()

    const state = recoverFromBuffer(tempDir, JOB_ID)
    expect(state.lastCheckpoint!.data).toEqual({ step: 3 })
    expect(state.eventsSinceCheckpoint).toHaveLength(1)
    expect(state.eventsSinceCheckpoint[0]!.data).toEqual({ tool: "deploy" })
  })
})
