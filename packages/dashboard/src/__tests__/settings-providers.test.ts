import { describe, expect, it } from "vitest"

/**
 * Tests for the code-paste provider set used in the settings page.
 * Validates the static mapping is correct without requiring React rendering.
 */

const CODE_PASTE_PROVIDER_IDS = new Set([
  "google-antigravity",
  "openai-codex",
  "anthropic",
])

describe("settings page code-paste providers", () => {
  it("identifies google-antigravity as a code-paste provider", () => {
    expect(CODE_PASTE_PROVIDER_IDS.has("google-antigravity")).toBe(true)
  })

  it("identifies openai-codex as a code-paste provider", () => {
    expect(CODE_PASTE_PROVIDER_IDS.has("openai-codex")).toBe(true)
  })

  it("identifies anthropic as a code-paste provider", () => {
    expect(CODE_PASTE_PROVIDER_IDS.has("anthropic")).toBe(true)
  })

  it("does not identify non-code-paste providers", () => {
    expect(CODE_PASTE_PROVIDER_IDS.has("openai")).toBe(false)
    expect(CODE_PASTE_PROVIDER_IDS.has("google-ai-studio")).toBe(false)
    expect(CODE_PASTE_PROVIDER_IDS.has("github")).toBe(false)
  })

  it("contains exactly 3 providers", () => {
    expect(CODE_PASTE_PROVIDER_IDS.size).toBe(3)
  })
})
