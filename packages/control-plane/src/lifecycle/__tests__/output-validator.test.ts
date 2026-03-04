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
  it("accepts content within the default character limit", () => {
    const result = validateMemoryWrite("Hello, world!")

    expect(result.valid).toBe(true)
    expect(result.sanitized).toBe("Hello, world!")
    expect(result.violations).toHaveLength(0)
  })

  it("accepts content at exactly the default limit", () => {
    const content = "a".repeat(DEFAULT_MEMORY_MAX_CHARS)
    const result = validateMemoryWrite(content)

    expect(result.valid).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it("rejects content exceeding the default 8,000 char limit", () => {
    const content = "a".repeat(DEFAULT_MEMORY_MAX_CHARS + 1)
    const result = validateMemoryWrite(content)

    expect(result.valid).toBe(false)
    expect(result.violations).toContain(`exceeds_max_chars:${DEFAULT_MEMORY_MAX_CHARS}`)
  })

  it("respects a custom character limit", () => {
    const result = validateMemoryWrite("abcdef", 5)

    expect(result.valid).toBe(false)
    expect(result.violations).toContain("exceeds_max_chars:5")
  })

  it("rejects binary content containing null bytes", () => {
    const result = validateMemoryWrite("hello\x00world")

    expect(result.valid).toBe(false)
    expect(result.violations).toContain("binary_content_detected")
  })

  it("rejects binary content with control characters", () => {
    const result = validateMemoryWrite("data\x01\x02\x03")

    expect(result.valid).toBe(false)
    expect(result.violations).toContain("binary_content_detected")
  })

  it("allows tabs, newlines, and carriage returns", () => {
    const result = validateMemoryWrite("line1\nline2\r\n\ttabbed")

    expect(result.valid).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it("reports multiple violations simultaneously", () => {
    const content = "\x00" + "a".repeat(DEFAULT_MEMORY_MAX_CHARS + 1)
    const result = validateMemoryWrite(content)

    expect(result.valid).toBe(false)
    expect(result.violations).toContain("binary_content_detected")
    expect(result.violations).toContain(`exceeds_max_chars:${DEFAULT_MEMORY_MAX_CHARS}`)
    expect(result.violations).toHaveLength(2)
  })

  it("accepts an empty string", () => {
    const result = validateMemoryWrite("")

    expect(result.valid).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  it("returns the original content as sanitized", () => {
    const content = "preserve me"
    const result = validateMemoryWrite(content)

    expect(result.sanitized).toBe(content)
  })

  it("default max is 8,000 characters", () => {
    expect(DEFAULT_MEMORY_MAX_CHARS).toBe(8_000)
  })
})

// ---------------------------------------------------------------------------
// validateCheckpointWrite
// ---------------------------------------------------------------------------

describe("validateCheckpointWrite", () => {
  it("accepts checkpoint data within the default 256 KB limit", () => {
    const data = { step: 1, state: "running" }
    const result = validateCheckpointWrite(data)

    expect(result.valid).toBe(true)
    expect(result.sanitized).toEqual(data)
    expect(result.violations).toHaveLength(0)
    expect(typeof result.crc).toBe("number")
  })

  it("computes a CRC32 for valid checkpoints", () => {
    const data = { step: 1 }
    const result = validateCheckpointWrite(data)

    expect(result.crc).toBe(computeCheckpointCrc(data))
  })

  it("rejects checkpoint data exceeding the default byte limit", () => {
    // Build an object larger than 256 KB
    const data: Record<string, unknown> = {}
    const bigString = "x".repeat(DEFAULT_CHECKPOINT_MAX_BYTES)
    data.payload = bigString

    const result = validateCheckpointWrite(data)

    expect(result.valid).toBe(false)
    expect(result.violations).toContain(`exceeds_max_bytes:${DEFAULT_CHECKPOINT_MAX_BYTES}`)
  })

  it("respects a custom byte limit", () => {
    const data = { key: "a".repeat(100) }
    const result = validateCheckpointWrite(data, 50)

    expect(result.valid).toBe(false)
    expect(result.violations).toContain("exceeds_max_bytes:50")
  })

  it("still computes CRC even when oversized", () => {
    const data = { key: "a".repeat(100) }
    const result = validateCheckpointWrite(data, 50)

    expect(result.valid).toBe(false)
    expect(typeof result.crc).toBe("number")
    expect(result.crc).toBe(computeCheckpointCrc(data))
  })

  it("default max is 256 KB", () => {
    expect(DEFAULT_CHECKPOINT_MAX_BYTES).toBe(256 * 1024)
  })
})

// ---------------------------------------------------------------------------
// computeCheckpointCrc
// ---------------------------------------------------------------------------

describe("computeCheckpointCrc", () => {
  it("returns a 32-bit unsigned integer", () => {
    const crc = computeCheckpointCrc({ hello: "world" })

    expect(crc).toBeGreaterThanOrEqual(0)
    expect(crc).toBeLessThanOrEqual(0xffffffff)
    expect(Number.isInteger(crc)).toBe(true)
  })

  it("is deterministic — same input always produces the same CRC", () => {
    const data = { step: 42, context: { nested: true } }

    const crc1 = computeCheckpointCrc(data)
    const crc2 = computeCheckpointCrc(data)

    expect(crc1).toBe(crc2)
  })

  it("produces the same CRC regardless of key insertion order", () => {
    const a = { z: 1, a: 2, m: 3 }
    const b = { a: 2, m: 3, z: 1 }

    expect(computeCheckpointCrc(a)).toBe(computeCheckpointCrc(b))
  })

  it("produces the same CRC for deeply nested objects with different key order", () => {
    const a = { outer: { z: 1, a: 2 }, list: [1, 2, 3] }
    const b = { list: [1, 2, 3], outer: { a: 2, z: 1 } }

    expect(computeCheckpointCrc(a)).toBe(computeCheckpointCrc(b))
  })

  it("produces different CRCs for different data", () => {
    const crc1 = computeCheckpointCrc({ step: 1 })
    const crc2 = computeCheckpointCrc({ step: 2 })

    expect(crc1).not.toBe(crc2)
  })

  it("handles an empty object", () => {
    const crc = computeCheckpointCrc({})

    expect(typeof crc).toBe("number")
    expect(crc).toBeGreaterThanOrEqual(0)
  })

  it("handles nested arrays and nulls", () => {
    const data = { items: [null, { x: 1 }, [2, 3]], value: null }
    const crc = computeCheckpointCrc(data)

    expect(typeof crc).toBe("number")
    // Determinism
    expect(computeCheckpointCrc(data)).toBe(crc)
  })
})

// ---------------------------------------------------------------------------
// verifyCheckpointIntegrity
// ---------------------------------------------------------------------------

describe("verifyCheckpointIntegrity", () => {
  it("returns true when data matches the expected CRC", () => {
    const data = { step: 10, state: "completed" }
    const crc = computeCheckpointCrc(data)

    expect(verifyCheckpointIntegrity(data, crc)).toBe(true)
  })

  it("returns false when data has been modified", () => {
    const original = { step: 10, state: "completed" }
    const crc = computeCheckpointCrc(original)

    const tampered = { step: 10, state: "failed" }
    expect(verifyCheckpointIntegrity(tampered, crc)).toBe(false)
  })

  it("returns false for an arbitrary wrong CRC", () => {
    const data = { step: 1 }
    expect(verifyCheckpointIntegrity(data, 0)).toBe(false)
  })

  it("returns true regardless of key order", () => {
    const data = { b: 2, a: 1 }
    const crc = computeCheckpointCrc({ a: 1, b: 2 })

    expect(verifyCheckpointIntegrity(data, crc)).toBe(true)
  })
})
