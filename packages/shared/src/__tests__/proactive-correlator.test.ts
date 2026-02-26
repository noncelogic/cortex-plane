import { describe, expect, it } from "vitest"

import { correlateSignals, tokenize } from "../proactive-detector/correlator.js"
import type { Signal } from "../proactive-detector/types.js"

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    source: "calendar",
    signalType: "event",
    title: "Test signal",
    summary: "A test signal for unit testing",
    confidence: 0.7,
    severity: "medium",
    opportunity: false,
    ...overrides,
  }
}

// ──────────────────────────────────────────────────
// tokenize
// ──────────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases and splits into words", () => {
    const tokens = tokenize("Hello World Testing")
    expect(tokens.has("hello")).toBe(true)
    expect(tokens.has("world")).toBe(true)
    expect(tokens.has("testing")).toBe(true)
  })

  it("removes stop words", () => {
    const tokens = tokenize("the quick fox and the lazy dog")
    expect(tokens.has("the")).toBe(false)
    expect(tokens.has("and")).toBe(false)
    expect(tokens.has("quick")).toBe(true)
    expect(tokens.has("fox")).toBe(true)
  })

  it("filters tokens shorter than 3 characters", () => {
    const tokens = tokenize("I am ok but not fine")
    expect(tokens.has("ok")).toBe(false)
    expect(tokens.has("am")).toBe(false)
    expect(tokens.has("fine")).toBe(true)
    expect(tokens.has("not")).toBe(false) // stop word
  })

  it("strips punctuation", () => {
    const tokens = tokenize("hello, world! testing...")
    expect(tokens.has("hello")).toBe(true)
    expect(tokens.has("world")).toBe(true)
    expect(tokens.has("testing")).toBe(true)
  })

  it("returns empty set for empty string", () => {
    expect(tokenize("").size).toBe(0)
  })

  it("returns empty set for only stop words", () => {
    expect(tokenize("the and or but in on at to for of").size).toBe(0)
  })

  it("deduplicates tokens", () => {
    const tokens = tokenize("hello hello hello world")
    expect(tokens.size).toBe(2)
  })
})

// ──────────────────────────────────────────────────
// correlateSignals
// ──────────────────────────────────────────────────

describe("correlateSignals", () => {
  it("detects calendar + email overlap", () => {
    const signals: Signal[] = [
      makeSignal({
        source: "calendar",
        title: "Sprint planning meeting",
        summary: "Discuss backlog items and sprint goals",
      }),
      makeSignal({
        source: "email",
        title: "Sprint planning preparation",
        summary: "Please review backlog items before sprint planning meeting",
      }),
    ]

    const cross = correlateSignals(signals)

    expect(cross).toHaveLength(1)
    expect(cross[0]!.source).toBe("cross_signal")
    expect(cross[0]!.signalType).toBe("calendar_email_correlation")
    expect(cross[0]!.confidence).toBeGreaterThanOrEqual(0.68)
    expect(cross[0]!.confidence).toBeLessThanOrEqual(0.93)
  })

  it("does not correlate when overlap is below threshold", () => {
    const signals: Signal[] = [
      makeSignal({
        source: "calendar",
        title: "Sprint planning",
        summary: "Team meeting",
      }),
      makeSignal({
        source: "email",
        title: "Vacation request",
        summary: "Booking flights",
      }),
    ]

    const cross = correlateSignals(signals)
    expect(cross).toHaveLength(0)
  })

  it("returns empty for signals from the same source", () => {
    const signals: Signal[] = [
      makeSignal({ source: "calendar", title: "Meeting alpha", summary: "Discuss alpha project" }),
      makeSignal({
        source: "calendar",
        title: "Meeting beta",
        summary: "Discuss alpha and beta project",
      }),
    ]

    const cross = correlateSignals(signals)
    expect(cross).toHaveLength(0)
  })

  it("handles empty signals list", () => {
    expect(correlateSignals([])).toHaveLength(0)
  })

  it("respects custom minOverlap parameter", () => {
    const signals: Signal[] = [
      makeSignal({
        source: "calendar",
        title: "Sprint review",
        summary: "Sprint review meeting",
      }),
      makeSignal({
        source: "email",
        title: "Sprint review notes",
        summary: "Notes from sprint review",
      }),
    ]

    // With minOverlap=2, should find match (sprint, review)
    const crossLow = correlateSignals(signals, 2)
    expect(crossLow.length).toBeGreaterThanOrEqual(1)

    // With minOverlap=100, should not match
    const crossHigh = correlateSignals(signals, 100)
    expect(crossHigh).toHaveLength(0)
  })

  it("caps confidence at 0.93", () => {
    const signals: Signal[] = [
      makeSignal({
        source: "calendar",
        title: "Deploy release kubernetes cluster migration backup",
        summary: "Deployment release kubernetes cluster migration backup infrastructure monitoring",
      }),
      makeSignal({
        source: "email",
        title: "Deploy release kubernetes cluster migration backup",
        summary: "Deployment release kubernetes cluster migration backup infrastructure monitoring",
      }),
    ]

    const cross = correlateSignals(signals)
    expect(cross).toHaveLength(1)
    expect(cross[0]!.confidence).toBeLessThanOrEqual(0.93)
  })

  it("sets severity based on confidence", () => {
    const signals: Signal[] = [
      makeSignal({
        source: "calendar",
        title: "Sprint planning review standup retro backlog grooming",
        summary: "Sprint planning review standup retro backlog grooming estimation",
      }),
      makeSignal({
        source: "email",
        title: "Sprint planning review standup retro backlog grooming",
        summary: "Sprint planning review standup retro backlog grooming estimation",
      }),
    ]

    const cross = correlateSignals(signals)
    expect(cross).toHaveLength(1)
    if (cross[0]!.confidence >= 0.8) {
      expect(cross[0]!.severity).toBe("high")
    } else {
      expect(cross[0]!.severity).toBe("medium")
    }
  })

  it("generates fingerprint for deduplication", () => {
    const signals: Signal[] = [
      makeSignal({
        source: "calendar",
        title: "Sprint planning review",
        summary: "Review sprint tasks",
      }),
      makeSignal({
        source: "email",
        title: "Sprint planning update",
        summary: "Update on sprint review items",
      }),
    ]

    const cross = correlateSignals(signals)
    if (cross.length > 0) {
      expect(cross[0]!.fingerprint).toBeDefined()
      expect(cross[0]!.fingerprint!.startsWith("cal_email:")).toBe(true)
    }
  })

  it("detects portfolio + behavioral correlation", () => {
    const signals: Signal[] = [
      makeSignal({
        source: "portfolio",
        title: "Stock alert technology sector",
        summary: "Technology sector showing unusual volume patterns",
      }),
      makeSignal({
        source: "behavioral",
        title: "Increased research technology",
        summary: "User researching technology sector investments patterns",
      }),
    ]

    const cross = correlateSignals(signals)
    expect(cross).toHaveLength(1)
    expect(cross[0]!.signalType).toBe("portfolio_behavior_correlation")
    expect(cross[0]!.opportunity).toBe(true)
  })
})
