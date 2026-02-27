import { describe, expect, it } from "vitest"

import { parseAuthorizationInput } from "../auth/parse-authorization-input.js"

describe("parseAuthorizationInput", () => {
  describe("standard URL with query params", () => {
    it("extracts code and state from a full redirect URL", () => {
      const input = "http://localhost:51121/oauth-callback?code=4/0AQSTgQG_abc123&state=somestate"
      const result = parseAuthorizationInput(input, "google-antigravity")
      expect(result).toEqual({
        code: "4/0AQSTgQG_abc123",
        state: "somestate",
      })
    })

    it("extracts code from URL without state", () => {
      const input = "http://localhost:1455/auth/callback?code=mycode"
      const result = parseAuthorizationInput(input, "openai-codex")
      expect(result).toEqual({
        code: "mycode",
        state: undefined,
      })
    })

    it("handles URL with extra query params", () => {
      const input = "http://localhost:51121/oauth-callback?code=abc&state=xyz&scope=openid"
      const result = parseAuthorizationInput(input, "google-antigravity")
      expect(result).toEqual({ code: "abc", state: "xyz" })
    })
  })

  describe("Anthropic code#state format", () => {
    it("extracts code and state from Anthropic callback URL with hash", () => {
      const input = "https://console.anthropic.com/oauth/code/callback?code=authcode123#statevalue"
      const result = parseAuthorizationInput(input, "anthropic")
      expect(result).toEqual({
        code: "authcode123",
        state: "statevalue",
      })
    })

    it("extracts code from Anthropic URL without hash", () => {
      const input = "https://console.anthropic.com/oauth/code/callback?code=authcode123"
      const result = parseAuthorizationInput(input, "anthropic")
      expect(result).toEqual({
        code: "authcode123",
        state: undefined,
      })
    })

    it("parses raw code#state string for Anthropic", () => {
      const input = "authcode123#statevalue456"
      const result = parseAuthorizationInput(input, "anthropic")
      expect(result).toEqual({
        code: "authcode123",
        state: "statevalue456",
      })
    })
  })

  describe("raw code string", () => {
    it("treats a plain string as a raw code", () => {
      const result = parseAuthorizationInput("myrawcode", "openai-codex")
      expect(result).toEqual({ code: "myrawcode" })
    })

    it("trims whitespace", () => {
      const result = parseAuthorizationInput("  mycode  ", "google-antigravity")
      expect(result).toEqual({ code: "mycode" })
    })
  })

  describe("edge cases", () => {
    it("returns null for empty string", () => {
      expect(parseAuthorizationInput("", "anthropic")).toBeNull()
    })

    it("returns null for whitespace-only string", () => {
      expect(parseAuthorizationInput("   ", "anthropic")).toBeNull()
    })

    it("handles non-Anthropic provider with hash in raw input as raw code", () => {
      const result = parseAuthorizationInput("code#state", "openai-codex")
      // Non-Anthropic: not a valid URL, treated as raw code
      expect(result).toEqual({ code: "code#state" })
    })
  })
})
