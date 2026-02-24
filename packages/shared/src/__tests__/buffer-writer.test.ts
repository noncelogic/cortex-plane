import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { BufferWriter } from "../buffer/writer.js"
import type { BufferEvent } from "../buffer/types.js"

const JOB_ID = "test-job-001"

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

describe("BufferWriter", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "buffer-writer-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("creates job directory and session file on construction", () => {
    const writer = new BufferWriter(tempDir, JOB_ID)
    expect(existsSync(join(tempDir, JOB_ID))).toBe(true)
    expect(existsSync(writer.currentFilePath)).toBe(true)
    writer.close()
  })

  it("writes events as newline-delimited JSON", () => {
    const writer = new BufferWriter(tempDir, JOB_ID)
    writer.append(makeEvent({ type: "SESSION_START" }))
    writer.append(makeEvent({ type: "LLM_REQUEST" }))
    writer.close()

    const content = readFileSync(writer.currentFilePath, "utf-8")
    const lines = content.split("\n").filter((l) => l.trim() !== "")
    expect(lines).toHaveLength(2)

    const first = JSON.parse(lines[0]!) as BufferEvent
    expect(first.type).toBe("SESSION_START")
    expect(first.sequence).toBe(0)

    const second = JSON.parse(lines[1]!) as BufferEvent
    expect(second.type).toBe("LLM_REQUEST")
    expect(second.sequence).toBe(1)
  })

  it("auto-increments sequence numbers", () => {
    const writer = new BufferWriter(tempDir, JOB_ID)
    for (let i = 0; i < 5; i++) {
      writer.append(makeEvent())
    }
    writer.close()

    const content = readFileSync(writer.currentFilePath, "utf-8")
    const lines = content.split("\n").filter((l) => l.trim() !== "")
    for (let i = 0; i < 5; i++) {
      const event = JSON.parse(lines[i]!) as BufferEvent
      expect(event.sequence).toBe(i)
    }
  })

  it("preserves all event fields in output", () => {
    const writer = new BufferWriter(tempDir, JOB_ID)
    const event = makeEvent({
      type: "TOOL_RESULT",
      data: { toolName: "file_read", result: "ok" },
      crc32: 12345,
    })
    writer.append(event)
    writer.close()

    const content = readFileSync(writer.currentFilePath, "utf-8")
    const parsed = JSON.parse(content.trim()) as BufferEvent
    expect(parsed.version).toBe("1.0")
    expect(parsed.jobId).toBe(JOB_ID)
    expect(parsed.sessionId).toBe("sess-001")
    expect(parsed.agentId).toBe("agent-001")
    expect(parsed.type).toBe("TOOL_RESULT")
    expect(parsed.data).toEqual({ toolName: "file_read", result: "ok" })
    expect(parsed.crc32).toBe(12345)
  })

  it("each line is valid JSON (no multi-line output)", () => {
    const writer = new BufferWriter(tempDir, JOB_ID)
    writer.append(makeEvent({ data: { message: "line1\nline2\nline3" } }))
    writer.close()

    const content = readFileSync(writer.currentFilePath, "utf-8")
    const lines = content.split("\n").filter((l) => l.trim() !== "")
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0]!)).not.toThrow()
  })

  it("starts a new session file with newSession()", () => {
    const writer = new BufferWriter(tempDir, JOB_ID)
    const firstPath = writer.currentFilePath
    writer.append(makeEvent({ type: "SESSION_START" }))

    writer.newSession()
    const secondPath = writer.currentFilePath
    expect(secondPath).not.toBe(firstPath)
    expect(writer.currentSessionNumber).toBe(2)

    writer.append(makeEvent({ type: "SESSION_START" }))
    writer.close()

    const firstContent = readFileSync(firstPath, "utf-8")
    const secondContent = readFileSync(secondPath, "utf-8")
    expect(firstContent.split("\n").filter((l) => l.trim()).length).toBe(1)
    expect(secondContent.split("\n").filter((l) => l.trim()).length).toBe(1)

    const secondEvent = JSON.parse(secondContent.trim()) as BufferEvent
    expect(secondEvent.sequence).toBe(0)
  })

  it("names session files with zero-padded numbers", () => {
    const writer = new BufferWriter(tempDir, JOB_ID)
    expect(writer.currentFilePath).toContain("session-001.jsonl")
    writer.newSession()
    expect(writer.currentFilePath).toContain("session-002.jsonl")
    writer.close()
  })

  it("writes metadata.json on writeMetadata()", () => {
    const writer = new BufferWriter(tempDir, JOB_ID)
    writer.writeMetadata({
      jobId: JOB_ID,
      agentId: "agent-001",
      sessionId: "sess-001",
      startedAt: new Date().toISOString(),
      sessionNumber: 1,
    })
    writer.close()

    const metaPath = join(tempDir, JOB_ID, "metadata.json")
    expect(existsSync(metaPath)).toBe(true)
    const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as Record<string, unknown>
    expect(meta.jobId).toBe(JOB_ID)
    expect(meta.basePath).toBe(tempDir)
  })

  it("resets sequence to 0 on newSession()", () => {
    const writer = new BufferWriter(tempDir, JOB_ID)
    writer.append(makeEvent())
    writer.append(makeEvent())
    expect(writer.currentSequence).toBe(2)

    writer.newSession()
    expect(writer.currentSequence).toBe(0)
    writer.append(makeEvent())
    expect(writer.currentSequence).toBe(1)
    writer.close()
  })
})
