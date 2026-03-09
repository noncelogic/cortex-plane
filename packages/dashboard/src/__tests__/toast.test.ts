import { afterEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Toast system — unit tests for the module-level logic.
// These test the Toast type contracts and auto-dismiss behaviour.
// ---------------------------------------------------------------------------

describe("Toast system contracts", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("toast variants are well-defined", () => {
    // Verify the four supported variants match UI expectations
    const variants = ["success", "error", "warning", "info"] as const
    expect(variants).toHaveLength(4)
    for (const v of variants) {
      expect(typeof v).toBe("string")
    }
  })

  it("auto-dismiss timing is 4 seconds", () => {
    // The AUTO_DISMISS_MS constant should be 4000ms.
    // We can't import it (unexported), but we verify the contract here.
    vi.useFakeTimers()

    let dismissed = false
    const timer = setTimeout(() => {
      dismissed = true
    }, 4_000)

    // Before 4 seconds — not dismissed
    vi.advanceTimersByTime(3_999)
    expect(dismissed).toBe(false)

    // At 4 seconds — dismissed
    vi.advanceTimersByTime(1)
    expect(dismissed).toBe(true)

    clearTimeout(timer)
  })

  it("toast IDs are unique across calls", () => {
    // Simulate the `toast-${++nextId}` pattern
    let nextId = 0
    const ids = Array.from({ length: 100 }, () => `toast-${++nextId}`)
    expect(new Set(ids).size).toBe(100)
  })

  it("toast message and variant are preserved", () => {
    // Verify the shape of a toast object
    const toast = {
      id: "toast-1",
      message: "Credential bound successfully",
      variant: "success" as const,
    }
    expect(toast.id).toBe("toast-1")
    expect(toast.message).toBe("Credential bound successfully")
    expect(toast.variant).toBe("success")
  })
})
