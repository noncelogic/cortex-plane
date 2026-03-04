/**
 * Output validation for agent memory writes and checkpoint integrity.
 *
 * Enforces size limits on memory writes, rejects binary content, and computes
 * CRC32 checksums for checkpoint data to detect corruption on read.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutputValidationResult {
  valid: boolean
  sanitized: string | Record<string, unknown>
  violations: string[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum characters for a memory write. */
export const DEFAULT_MEMORY_MAX_CHARS = 8_000

/** Default maximum bytes for a checkpoint write (256 KB). */
export const DEFAULT_CHECKPOINT_MAX_BYTES = 256 * 1024

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

/** IEEE 802.3 CRC32 lookup table. */
const CRC32_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
    table[i] = crc
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buf[i]!) & 0xff]!
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Deterministic JSON stringify with sorted keys.
 * Ensures the same object always produces the same byte sequence for CRC
 * regardless of property insertion order.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null"

  const type = typeof value
  if (type === "string" || type === "number" || type === "boolean") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return "[" + value.map((item) => stableStringify(item ?? null)).join(",") + "]"
  }

  if (type === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const parts: string[] = []
    for (const k of keys) {
      const v = record[k]
      if (v !== undefined) {
        parts.push(JSON.stringify(k) + ":" + stableStringify(v))
      }
    }
    return "{" + parts.join(",") + "}"
  }

  return "null"
}

// ---------------------------------------------------------------------------
// Binary content detection
// ---------------------------------------------------------------------------

/** Control characters that indicate binary content (excludes \t \n \r). */
const BINARY_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a memory write.
 *
 * - Rejects binary content (contains control characters like null bytes).
 * - Rejects content exceeding the character limit (default 8,000).
 */
export function validateMemoryWrite(
  content: string,
  maxChars: number = DEFAULT_MEMORY_MAX_CHARS,
): OutputValidationResult {
  const violations: string[] = []

  if (BINARY_CHAR_RE.test(content)) {
    violations.push("binary_content_detected")
  }

  if (content.length > maxChars) {
    violations.push(`exceeds_max_chars:${maxChars}`)
  }

  return {
    valid: violations.length === 0,
    sanitized: content,
    violations,
  }
}

/**
 * Validate a checkpoint write.
 *
 * - Rejects data exceeding the byte size limit (default 256 KB).
 * - Computes a CRC32 checksum for integrity verification on subsequent reads.
 */
export function validateCheckpointWrite(
  data: Record<string, unknown>,
  maxBytes: number = DEFAULT_CHECKPOINT_MAX_BYTES,
): OutputValidationResult & { crc: number } {
  const violations: string[] = []
  const serialized = stableStringify(data)
  const byteLength = Buffer.byteLength(serialized, "utf8")

  if (byteLength > maxBytes) {
    violations.push(`exceeds_max_bytes:${maxBytes}`)
  }

  const crc = crc32(Buffer.from(serialized, "utf8"))

  return {
    valid: violations.length === 0,
    sanitized: data,
    violations,
    crc,
  }
}

/**
 * Compute a deterministic CRC32 for checkpoint data.
 * Uses stable (sorted-key) JSON serialization to ensure consistency.
 */
export function computeCheckpointCrc(data: Record<string, unknown>): number {
  const serialized = stableStringify(data)
  return crc32(Buffer.from(serialized, "utf8"))
}

/**
 * Verify checkpoint data integrity against an expected CRC32 checksum.
 */
export function verifyCheckpointIntegrity(
  data: Record<string, unknown>,
  expectedCrc: number,
): boolean {
  return computeCheckpointCrc(data) === expectedCrc
}
