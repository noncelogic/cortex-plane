/**
 * Output validation for agent memory writes and checkpoint integrity.
 *
 * Validates content before persisting, enforces size limits, detects binary
 * content, and provides CRC32 integrity checking for checkpoints.
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

export const DEFAULT_MEMORY_MAX_CHARS = 8_000
export const DEFAULT_CHECKPOINT_MAX_BYTES = 256 * 1024 // 256 KB

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const CRC32_TABLE = /* @__PURE__ */ buildCrc32Table()

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c
  }
  return table
}

/**
 * Compute a deterministic CRC32 for a checkpoint object.
 *
 * Keys are sorted recursively so that property insertion order does not
 * affect the resulting checksum.
 */
export function computeCheckpointCrc(data: Record<string, unknown>): number {
  const json = deterministicStringify(data)
  const buf = Buffer.from(json, "utf8")
  let crc = 0xffffffff
  for (const byte of buf) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Verify that a checkpoint's CRC matches the expected value.
 */
export function verifyCheckpointIntegrity(
  data: Record<string, unknown>,
  expectedCrc: number,
): boolean {
  return computeCheckpointCrc(data) === expectedCrc
}

// ---------------------------------------------------------------------------
// Memory write validation
// ---------------------------------------------------------------------------

/**
 * Validate content before writing to agent memory.
 *
 * Rejects binary content and payloads exceeding the character limit.
 */
export function validateMemoryWrite(
  content: string,
  maxChars: number = DEFAULT_MEMORY_MAX_CHARS,
): OutputValidationResult {
  const violations: string[] = []

  if (isBinaryContent(content)) {
    violations.push("binary content detected")
    return { valid: false, sanitized: "", violations }
  }

  if (content.length > maxChars) {
    violations.push(`content exceeds ${maxChars} character limit (${content.length} chars)`)
    return { valid: false, sanitized: content, violations }
  }

  return { valid: true, sanitized: content, violations }
}

// ---------------------------------------------------------------------------
// Checkpoint write validation
// ---------------------------------------------------------------------------

/**
 * Validate a checkpoint payload before writing.
 *
 * Rejects oversized payloads and computes a CRC32 for integrity verification.
 * When valid, `sanitized` contains the original data (unchanged).
 */
export function validateCheckpointWrite(
  data: Record<string, unknown>,
  maxBytes: number = DEFAULT_CHECKPOINT_MAX_BYTES,
): OutputValidationResult {
  const violations: string[] = []
  const json = deterministicStringify(data)
  const byteLength = Buffer.byteLength(json, "utf8")

  if (byteLength > maxBytes) {
    violations.push(`checkpoint exceeds ${maxBytes} byte limit (${byteLength} bytes)`)
    return { valid: false, sanitized: data, violations }
  }

  return { valid: true, sanitized: data, violations }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect binary content by checking for null bytes and excessive control
 * characters (excluding common whitespace).
 */
function isBinaryContent(content: string): boolean {
  if (content.includes("\0")) return true

  let controlCount = 0
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i)
    // Control chars 0x00–0x1F excluding tab (0x09), LF (0x0A), CR (0x0D)
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      controlCount++
    }
  }

  // More than 5% control characters indicates binary
  return content.length > 0 && controlCount / content.length > 0.05
}

/**
 * Produce a deterministic JSON string by sorting object keys recursively.
 */
function deterministicStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer)
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k]
    }
    return sorted
  }
  return value
}
