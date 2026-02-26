import { describe, expect, it } from "vitest"

import {
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
} from "../memory/extraction-prompt.js"

describe("buildExtractionSystemPrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildExtractionSystemPrompt()
    expect(prompt.length).toBeGreaterThan(100)
  })

  it("contains fact type definitions", () => {
    const prompt = buildExtractionSystemPrompt()
    for (const type of ["fact", "preference", "event", "system_rule", "lesson", "relationship"]) {
      expect(prompt).toContain(type)
    }
  })

  it("contains JSON output format instructions", () => {
    const prompt = buildExtractionSystemPrompt()
    expect(prompt).toContain('"facts"')
    expect(prompt).toContain('"content"')
    expect(prompt).toContain('"type"')
    expect(prompt).toContain('"confidence"')
    expect(prompt).toContain('"importance"')
    expect(prompt).toContain('"source"')
  })

  it("contains few-shot examples", () => {
    const prompt = buildExtractionSystemPrompt()
    expect(prompt).toContain("sessionId")
    expect(prompt).toContain("turnIndex")
  })
})

describe("buildExtractionUserPrompt", () => {
  const messages = [
    { role: "user", content: "How do I deploy the service?", timestamp: "2025-01-15T10:00:00Z" },
    {
      role: "assistant",
      content: "Use kubectl apply with the manifest.",
      timestamp: "2025-01-15T10:01:00Z",
    },
    { role: "user", content: "Which namespace?", timestamp: "2025-01-15T10:02:00Z" },
  ]

  it("includes session ID", () => {
    const prompt = buildExtractionUserPrompt("sess-123", messages)
    expect(prompt).toContain("sess-123")
  })

  it("includes all messages with indices", () => {
    const prompt = buildExtractionUserPrompt("sess-123", messages)
    expect(prompt).toContain("[0]")
    expect(prompt).toContain("[1]")
    expect(prompt).toContain("[2]")
  })

  it("includes message roles and content", () => {
    const prompt = buildExtractionUserPrompt("sess-123", messages)
    expect(prompt).toContain("user: How do I deploy the service?")
    expect(prompt).toContain("assistant: Use kubectl apply with the manifest.")
  })

  it("includes timestamps", () => {
    const prompt = buildExtractionUserPrompt("sess-123", messages)
    expect(prompt).toContain("2025-01-15T10:00:00Z")
    expect(prompt).toContain("2025-01-15T10:01:00Z")
  })

  it("includes transcript markers", () => {
    const prompt = buildExtractionUserPrompt("sess-123", messages)
    expect(prompt).toContain("TRANSCRIPT START")
    expect(prompt).toContain("TRANSCRIPT END")
  })

  it("handles empty messages", () => {
    const prompt = buildExtractionUserPrompt("sess-123", [])
    expect(prompt).toContain("sess-123")
    expect(prompt).toContain("TRANSCRIPT START")
    expect(prompt).toContain("TRANSCRIPT END")
  })
})
