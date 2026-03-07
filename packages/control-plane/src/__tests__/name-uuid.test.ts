import { describe, expect, it } from "vitest"

import { ensureUuid, toNameUuid } from "../util/name-uuid.js"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe("toNameUuid", () => {
  it("produces a valid UUID-shaped string", () => {
    expect(toNameUuid("dev-user")).toMatch(UUID_RE)
  })

  it("is deterministic", () => {
    expect(toNameUuid("dev-user")).toBe(toNameUuid("dev-user"))
  })

  it("different inputs produce different UUIDs", () => {
    expect(toNameUuid("dev-user")).not.toBe(toNameUuid("api-user"))
  })

  it("sets version nibble to 4", () => {
    const uuid = toNameUuid("test-input")
    // Third group starts with the version nibble
    expect(uuid.split("-")[2]![0]).toBe("4")
  })

  it("sets variant bits to 10xx", () => {
    const uuid = toNameUuid("test-input")
    const variantNibble = parseInt(uuid.split("-")[3]![0]!, 16)
    // Variant 10xx means the high two bits are 10 → value 8, 9, a, or b
    expect(variantNibble).toBeGreaterThanOrEqual(8)
    expect(variantNibble).toBeLessThanOrEqual(0xb)
  })
})

describe("ensureUuid", () => {
  it("returns valid UUIDs unchanged", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    expect(ensureUuid(uuid)).toBe(uuid)
  })

  it("converts non-UUID strings to a UUID", () => {
    const result = ensureUuid("dev-user")
    expect(result).toMatch(UUID_RE)
    expect(result).not.toBe("dev-user")
  })

  it("converts non-UUID strings deterministically", () => {
    expect(ensureUuid("user-1")).toBe(ensureUuid("user-1"))
  })

  it("produces the same result as toNameUuid for non-UUID inputs", () => {
    expect(ensureUuid("dev-user")).toBe(toNameUuid("dev-user"))
  })
})
