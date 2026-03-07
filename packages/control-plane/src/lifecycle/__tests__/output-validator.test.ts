import { describe, expect, it } from "vitest"

import {
  computeCheckpointCrc,
  DEFAULT_CHECKPOINT_MAX_BYTES,
  DEFAULT_MEMORY_MAX_CHARS,
  validateCheckpointWrite,
  validateMemoryWrite,
  verifyCheckpointIntegrity,
} from "../output-validator.js"

// ---------------------------------------------------------------------------
// validateMemoryWrite
// ---------------------------------------------------------------------------

describe("validateMemoryWrite", () => {
  it("accepts content within the default limit", () => {
    const result = validateMemoryWrite("hello world")
    expect(result.valid).toBe(true)
    expect(result.sanitized).toBe("hello world")
    expect(result.violations).toHaveLength(0)
  })

  it("accepts content at exactly the limit", () => {
    const content = "a".repeat(DEFAULT_MEMORY_MAX_CHARS)
    const result = validateMemoryWrite(content)
    expect(result.valid).toBe(true)
  })

  it("rejects content exceeding the default 8,000 char limit", () => {
    const content = "x".repeat(DEFAULT_MEMORY_MAX_CHARS + 1)
    const result = validateMemoryWrite(content)
    expect(result.valid).toBe(false)
    expect(result.violations[0]).toContain("character limit")
  })

  it("rejects content exceeding a custom limit", () => {
    const result = validateMemoryWrite("too long", 5)
    expect(result.valid).toBe(false)
    expect(result.violations[0]).toContain("5 character limit")
  })

  it("rejects binary content with null bytes", () => {
    const result = validateMemoryWrite("hello\0world")
    expect(result.valid).toBe(false)
    expect(result.violations[0]).toContain("binary content")
  })

  it("rejects content with excessive control characters", () => {
    // >5% control characters (excluding tab/LF/CR)
    const controlChars = "\x01\x02\x03\x04\x05\x06"
    const padding = "a".repeat(50) // 6/56 ≈ 10.7% > 5%
    const result = validateMemoryWrite(controlChars + padding)
    expect(result.valid).toBe(false)
    expect(result.violations[0]).toContain("binary content")
  })

  it("allows content with tabs and newlines", () => {
    const content = "line1\nline2\ttab\r\nline3"
    const result = validateMemoryWrite(content)
    expect(result.valid).toBe(true)
  })

  it("accepts empty content", () => {
    const result = validateMemoryWrite("")
    expect(result.valid).toBe(true)
    expect(result.sanitized).toBe("")
  })
})

// ---------------------------------------------------------------------------
// validateCheckpointWrite
// ---------------------------------------------------------------------------

describe("validateCheckpointWrite", () => {
  it("accepts a checkpoint within the default 256 KB limit", () => {
    const data = { step: 3, state: "running" }
    const result = validateCheckpointWrite(data)
    expect(result.valid).toBe(true)
    expect(result.sanitized).toEqual(data)
    expect(result.violations).toHaveLength(0)
  })

  it("rejects a checkpoint exceeding the byte limit", () => {
    const bigValue = "x".repeat(DEFAULT_CHECKPOINT_MAX_BYTES)
    const data = { payload: bigValue }
    const result = validateCheckpointWrite(data)
    expect(result.valid).toBe(false)
    expect(result.violations[0]).toContain("byte limit")
  })

  it("rejects a checkpoint exceeding a custom byte limit", () => {
    const data = { key: "value" }
    const result = validateCheckpointWrite(data, 5)
    expect(result.valid).toBe(false)
    expect(result.violations[0]).toContain("5 byte limit")
  })

  it("accepts a checkpoint at exactly the byte limit", () => {
    const json = JSON.stringify({ a: 1 })
    const result = validateCheckpointWrite({ a: 1 }, Buffer.byteLength(json, "utf8"))
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// computeCheckpointCrc / verifyCheckpointIntegrity
// ---------------------------------------------------------------------------

describe("computeCheckpointCrc", () => {
  it("returns a positive 32-bit integer", () => {
    const crc = computeCheckpointCrc({ step: 1 })
    expect(crc).toBeGreaterThanOrEqual(0)
    expect(crc).toBeLessThanOrEqual(0xffffffff)
    expect(Number.isInteger(crc)).toBe(true)
  })

  it("is deterministic for the same input", () => {
    const data = { step: 1, nested: { a: "b" } }
    expect(computeCheckpointCrc(data)).toBe(computeCheckpointCrc(data))
  })

  it("produces the same CRC regardless of key insertion order", () => {
    const a = { z: 1, a: 2, m: 3 }
    const b = { a: 2, m: 3, z: 1 }
    expect(computeCheckpointCrc(a)).toBe(computeCheckpointCrc(b))
  })

  it("produces stable CRC for nested objects with different key order", () => {
    const a = { outer: { z: 1, a: 2 } }
    const b = { outer: { a: 2, z: 1 } }
    expect(computeCheckpointCrc(a)).toBe(computeCheckpointCrc(b))
  })

  it("produces different CRCs for different data", () => {
    const crc1 = computeCheckpointCrc({ step: 1 })
    const crc2 = computeCheckpointCrc({ step: 2 })
    expect(crc1).not.toBe(crc2)
  })
})

describe("verifyCheckpointIntegrity", () => {
  it("returns true when CRC matches", () => {
    const data = { step: 5, context: { task: "test" } }
    const crc = computeCheckpointCrc(data)
    expect(verifyCheckpointIntegrity(data, crc)).toBe(true)
  })

  it("returns false when data has been modified", () => {
    const original = { step: 5 }
    const crc = computeCheckpointCrc(original)
    const modified = { step: 6 }
    expect(verifyCheckpointIntegrity(modified, crc)).toBe(false)
  })

  it("returns false for an arbitrary wrong CRC", () => {
    expect(verifyCheckpointIntegrity({ a: 1 }, 0)).toBe(false)
  })
})
