import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { BufferReader, scanBuffer } from "../buffer/reader.js"
import type { BufferEvent } from "../buffer/types.js"

const JOB_ID = "test-job-reader"

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

describe("scanBuffer", () => {
  it("parses valid JSONL content", () => {
    const content = [makeEventLine({ sequence: 0 }), makeEventLine({ sequence: 1 })].join("\n")

    const result = scanBuffer(content)
    expect(result.events).toHaveLength(2)
    expect(result.corruptedLines).toBe(0)
    expect(result.lastLineTruncated).toBe(false)
  })

  it("handles trailing newline", () => {
    const content = makeEventLine() + "\n"
    const result = scanBuffer(content)
    expect(result.events).toHaveLength(1)
    expect(result.corruptedLines).toBe(0)
  })

  it("detects truncated last line", () => {
    const content = [makeEventLine(), '{"type":"LLM_RESP'].join("\n")

    const result = scanBuffer(content)
    expect(result.events).toHaveLength(1)
    expect(result.lastLineTruncated).toBe(true)
    expect(result.corruptedLines).toBe(0)
  })

  it("counts interior corrupt lines", () => {
    const content = [makeEventLine({ sequence: 0 }), "GARBAGE_DATA", makeEventLine({ sequence: 2 })].join("\n")

    const result = scanBuffer(content)
    expect(result.events).toHaveLength(2)
    expect(result.corruptedLines).toBe(1)
    expect(result.lastLineTruncated).toBe(false)
  })

  it("rejects JSON that lacks type field", () => {
    const content = '{"timestamp":"2024-01-01T00:00:00Z","data":{}}'
    const result = scanBuffer(content)
    expect(result.events).toHaveLength(0)
    expect(result.corruptedLines).toBe(1)
  })

  it("rejects JSON that lacks timestamp field", () => {
    const content = '{"type":"ERROR","data":{}}'
    const result = scanBuffer(content)
    expect(result.events).toHaveLength(0)
    expect(result.corruptedLines).toBe(1)
  })

  it("rejects JSON arrays", () => {
    const content = '[1, 2, 3]'
    const result = scanBuffer(content)
    expect(result.events).toHaveLength(0)
    expect(result.corruptedLines).toBe(1)
  })

  it("skips empty lines", () => {
    const content = [makeEventLine(), "", "", makeEventLine({ sequence: 1 }), ""].join("\n")

    const result = scanBuffer(content)
    expect(result.events).toHaveLength(2)
    expect(result.corruptedLines).toBe(0)
  })

  it("handles empty content", () => {
    const result = scanBuffer("")
    expect(result.events).toHaveLength(0)
    expect(result.corruptedLines).toBe(0)
    expect(result.lastLineTruncated).toBe(false)
  })

  it("handles both interior corruption and truncated tail", () => {
    const content = [
      makeEventLine({ sequence: 0 }),
      "NOT_JSON",
      makeEventLine({ sequence: 2 }),
      '{"type":"TRUNC',
    ].join("\n")

    const result = scanBuffer(content)
    expect(result.events).toHaveLength(2)
    expect(result.corruptedLines).toBe(1)
    expect(result.lastLineTruncated).toBe(true)
  })
})

describe("BufferReader", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "buffer-reader-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("returns empty array when job directory does not exist", () => {
    const reader = new BufferReader(tempDir, "nonexistent-job")
    expect(reader.readAll()).toEqual([])
    expect(reader.readLatestSession()).toEqual([])
    expect(reader.findLastCheckpoint()).toBeNull()
  })

  it("reads all events from all session files", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })

    writeFileSync(
      join(jobDir, "session-001.jsonl"),
      [
        makeEventLine({ sequence: 0, type: "SESSION_START" }),
        makeEventLine({ sequence: 1, type: "LLM_REQUEST" }),
      ].join("\n") + "\n",
    )
    writeFileSync(
      join(jobDir, "session-002.jsonl"),
      [
        makeEventLine({ sequence: 0, type: "SESSION_START" }),
        makeEventLine({ sequence: 1, type: "CHECKPOINT" }),
      ].join("\n") + "\n",
    )

    const reader = new BufferReader(tempDir, JOB_ID)
    const events = reader.readAll()
    expect(events).toHaveLength(4)
  })

  it("reads only the latest session file", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })

    writeFileSync(
      join(jobDir, "session-001.jsonl"),
      makeEventLine({ sequence: 0, type: "SESSION_START" }) + "\n",
    )
    writeFileSync(
      join(jobDir, "session-002.jsonl"),
      makeEventLine({ sequence: 0, type: "CHECKPOINT" }) + "\n",
    )

    const reader = new BufferReader(tempDir, JOB_ID)
    const events = reader.readLatestSession()
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe("CHECKPOINT")
  })

  it("finds the last checkpoint across all sessions", () => {
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
        makeEventLine({ sequence: 1, type: "LLM_REQUEST" }),
        makeEventLine({ sequence: 2, type: "CHECKPOINT", data: { step: 3 } }),
        makeEventLine({ sequence: 3, type: "LLM_RESPONSE" }),
      ].join("\n") + "\n",
    )

    const reader = new BufferReader(tempDir, JOB_ID)
    const checkpoint = reader.findLastCheckpoint()
    expect(checkpoint).not.toBeNull()
    expect(checkpoint!.data).toEqual({ step: 3 })
  })

  it("returns null when no checkpoint exists", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })

    writeFileSync(
      join(jobDir, "session-001.jsonl"),
      makeEventLine({ type: "LLM_REQUEST" }) + "\n",
    )

    const reader = new BufferReader(tempDir, JOB_ID)
    expect(reader.findLastCheckpoint()).toBeNull()
  })

  it("ignores non-session files in the directory", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })

    writeFileSync(join(jobDir, "metadata.json"), "{}")
    writeFileSync(join(jobDir, "notes.txt"), "hello")
    writeFileSync(
      join(jobDir, "session-001.jsonl"),
      makeEventLine({ type: "SESSION_START" }) + "\n",
    )

    const reader = new BufferReader(tempDir, JOB_ID)
    const events = reader.readAll()
    expect(events).toHaveLength(1)
  })

  it("handles corruption in session files gracefully", () => {
    const jobDir = join(tempDir, JOB_ID)
    mkdirSync(jobDir, { recursive: true })

    writeFileSync(
      join(jobDir, "session-001.jsonl"),
      [makeEventLine({ sequence: 0 }), "GARBAGE", makeEventLine({ sequence: 2 })].join("\n") +
        "\n",
    )

    const reader = new BufferReader(tempDir, JOB_ID)
    const events = reader.readAll()
    expect(events).toHaveLength(2)
  })
})
