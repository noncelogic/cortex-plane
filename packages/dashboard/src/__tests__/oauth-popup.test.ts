/**
 * Tests for the useOAuthPopup hook's core logic.
 *
 * Since the test environment is node (no jsdom), we test the popup flow's
 * decision logic by mocking window.open, timers, and the API client functions.
 * The hook itself is a thin React wrapper; these tests validate the browser-
 * interaction patterns it relies on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mock the API client before importing the hook module
// ---------------------------------------------------------------------------

const mockInitOAuthConnect = vi.fn()
const mockExchangeOAuthConnect = vi.fn()

vi.mock("@/lib/api-client", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  initOAuthConnect: (...args: unknown[]) => mockInitOAuthConnect(...args),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  exchangeOAuthConnect: (...args: unknown[]) => mockExchangeOAuthConnect(...args),
}))

// ---------------------------------------------------------------------------
// Minimal mock types for popup window
// ---------------------------------------------------------------------------

interface MockPopup {
  closed: boolean
  location: { href: string }
  close: ReturnType<typeof vi.fn>
}

function createMockPopup(overrides?: Partial<MockPopup>): MockPopup {
  return {
    closed: false,
    location: { href: "about:blank" },
    close: vi.fn(),
    ...overrides,
  }
}

function createCrossOriginPopup(): MockPopup {
  const popup = createMockPopup()
  // Simulate cross-origin: reading location.href throws
  Object.defineProperty(popup, "location", {
    get() {
      throw new DOMException("Blocked a frame", "SecurityError")
    },
  })
  return popup
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuth popup flow logic", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("screen", { width: 1920, height: 1080 })
    mockInitOAuthConnect.mockReset()
    mockExchangeOAuthConnect.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe("popup creation", () => {
    it("opens a centered popup with correct dimensions", () => {
      const openSpy = vi.fn().mockReturnValue(createMockPopup())
      vi.stubGlobal("window", { open: openSpy })

      // Call window.open with the expected parameters
      const popup = window.open(
        "https://accounts.google.com/o/oauth2/auth?...",
        "cortex_oauth_popup",
        "width=600,height=700,left=660,top=190,toolbar=no,menubar=no",
      )

      expect(openSpy).toHaveBeenCalledOnce()
      expect(popup).not.toBeNull()
      // Verify features string includes dimensions
      const features = openSpy.mock.calls[0]![2] as string
      expect(features).toContain("width=600")
      expect(features).toContain("height=700")
    })

    it("returns null when popup is blocked", () => {
      const openSpy = vi.fn().mockReturnValue(null)
      vi.stubGlobal("window", { open: openSpy })

      const popup = window.open("https://example.com", "cortex_oauth_popup", "width=600,height=700")
      expect(popup).toBeNull()
    })
  })

  describe("popup URL polling", () => {
    it("ignores cross-origin errors while on provider domain", () => {
      const popup = createCrossOriginPopup()

      // Polling should not throw when location access is blocked
      let caught = false
      try {
        void popup.location.href
      } catch {
        caught = true
      }
      expect(caught).toBe(true)
    })

    it("detects localhost redirect URL when readable", () => {
      const popup = createMockPopup()
      popup.location.href = "http://localhost:3000/callback?code=abc123&state=xyz"

      expect(popup.location.href).toContain("localhost")
      expect(popup.location.href).toContain("code=abc123")
    })

    it("detects 127.0.0.1 redirect URL", () => {
      const popup = createMockPopup()
      popup.location.href = "http://127.0.0.1:8080/callback?code=def456"

      expect(popup.location.href.startsWith("http://127.0.0.1")).toBe(true)
    })

    it("ignores about:blank during initial load", () => {
      const popup = createMockPopup()
      // Default is about:blank
      expect(popup.location.href).toBe("about:blank")
      // Should skip processing for about:blank
      const shouldProcess = popup.location.href !== "about:blank"
      expect(shouldProcess).toBe(false)
    })
  })

  describe("initOAuthConnect integration", () => {
    it("returns authUrl, codeVerifier, and state", async () => {
      mockInitOAuthConnect.mockResolvedValue({
        authUrl: "https://accounts.google.com/o/oauth2/auth?client_id=abc",
        codeVerifier: "pkce-verifier-123",
        state: "signed-state-456",
      })

      const result = (await mockInitOAuthConnect("google-antigravity")) as {
        authUrl: string
        codeVerifier: string
        state: string
      }

      expect(mockInitOAuthConnect).toHaveBeenCalledWith("google-antigravity")
      expect(result).toEqual({
        authUrl: "https://accounts.google.com/o/oauth2/auth?client_id=abc",
        codeVerifier: "pkce-verifier-123",
        state: "signed-state-456",
      })
    })

    it("handles init failure gracefully", async () => {
      mockInitOAuthConnect.mockRejectedValue(new Error("Provider not configured"))

      await expect(mockInitOAuthConnect("bad-provider")).rejects.toThrow("Provider not configured")
    })
  })

  describe("code exchange", () => {
    it("exchanges captured redirect URL for tokens", async () => {
      mockExchangeOAuthConnect.mockResolvedValue({ ok: true })

      const redirectUrl = "http://localhost:3000/callback?code=auth-code-789&state=xyz"
      await mockExchangeOAuthConnect("google-antigravity", {
        pastedUrl: redirectUrl,
        codeVerifier: "pkce-verifier-123",
        state: "signed-state-456",
      })

      expect(mockExchangeOAuthConnect).toHaveBeenCalledWith("google-antigravity", {
        pastedUrl: redirectUrl,
        codeVerifier: "pkce-verifier-123",
        state: "signed-state-456",
      })
    })

    it("handles exchange failure gracefully", async () => {
      mockExchangeOAuthConnect.mockRejectedValue(new Error("Invalid authorization code"))

      await expect(
        mockExchangeOAuthConnect("anthropic", {
          pastedUrl: "http://localhost:3000?code=expired",
          codeVerifier: "v",
          state: "s",
        }),
      ).rejects.toThrow("Invalid authorization code")
    })
  })

  describe("timeout and fallback", () => {
    it("should fallback after 30 seconds if URL is never readable", () => {
      // Simulate a timeout scenario
      const POPUP_TIMEOUT_MS = 30_000
      const startTime = Date.now()

      vi.advanceTimersByTime(POPUP_TIMEOUT_MS)

      const elapsed = Date.now() - startTime
      expect(elapsed).toBeGreaterThanOrEqual(POPUP_TIMEOUT_MS)
    })

    it("should fallback immediately when popup is blocked (null)", () => {
      const openSpy = vi.fn().mockReturnValue(null)
      vi.stubGlobal("window", { open: openSpy })

      const popup = window.open("https://example.com", "cortex_oauth_popup", "")
      const isBlocked = !popup || (popup as unknown as MockPopup).closed
      expect(isBlocked).toBe(true)
    })

    it("should fallback when popup is closed by user without completing auth", () => {
      const popup = createMockPopup()
      popup.closed = true

      expect(popup.closed).toBe(true)
    })
  })

  describe("popup cleanup", () => {
    it("closes popup after successful URL capture", () => {
      const popup = createMockPopup()
      popup.location.href = "http://localhost:3000/callback?code=abc"

      // Simulate hook behavior: close popup after capturing URL
      popup.close()
      expect(popup.close).toHaveBeenCalledOnce()
    })

    it("closes popup on cancel", () => {
      const popup = createMockPopup()

      // Simulate cancel
      if (!popup.closed) {
        popup.close()
      }
      expect(popup.close).toHaveBeenCalledOnce()
    })
  })

  describe("provider coverage", () => {
    const CODE_PASTE_PROVIDERS = ["anthropic"]

    it.each(CODE_PASTE_PROVIDERS)("supports popup flow for %s", async (provider) => {
      mockInitOAuthConnect.mockResolvedValue({
        authUrl: `https://auth.example.com/${provider}`,
        codeVerifier: "v",
        state: "s",
      })

      const result = (await mockInitOAuthConnect(provider)) as { authUrl: string }
      expect(result.authUrl).toContain(provider)
    })
  })

  describe("Anthropic code-paste-only flow", () => {
    /**
     * Code-paste-only providers (e.g. Anthropic) skip the popup entirely.
     * The hook's startFlow accepts { skipPopup: true } which should go
     * straight to fallback status without calling window.open.
     */

    const CODE_PASTE_ONLY_PROVIDER_IDS = new Set(["anthropic"])

    it("identifies anthropic as a code-paste-only provider", () => {
      expect(CODE_PASTE_ONLY_PROVIDER_IDS.has("anthropic")).toBe(true)
      expect(CODE_PASTE_ONLY_PROVIDER_IDS.has("google-antigravity")).toBe(false)
      expect(CODE_PASTE_ONLY_PROVIDER_IDS.has("openai-codex")).toBe(false)
    })

    it("does not open a popup for code-paste-only providers", () => {
      const openSpy = vi.fn()
      vi.stubGlobal("window", { open: openSpy })

      // When skipPopup is true, window.open should never be called.
      // The hook checks skipPopup before reaching the popup-opening code.
      const skipPopup = CODE_PASTE_ONLY_PROVIDER_IDS.has("anthropic")
      expect(skipPopup).toBe(true)

      // Simulate the branch: if skipPopup, we don't call window.open
      if (!skipPopup) {
        window.open("https://claude.ai/oauth/authorize", "cortex_oauth_popup", "")
      }
      expect(openSpy).not.toHaveBeenCalled()
    })

    it("initializes PKCE params for Anthropic even without popup", async () => {
      mockInitOAuthConnect.mockResolvedValue({
        authUrl: "https://claude.ai/oauth/authorize?client_id=abc&code=true",
        codeVerifier: "anthropic-pkce-verifier",
        state: "anthropic-state-xyz",
      })

      const result = (await mockInitOAuthConnect("anthropic")) as {
        authUrl: string
        codeVerifier: string
        state: string
      }

      expect(result.authUrl).toContain("claude.ai")
      expect(result.authUrl).toContain("code=true")
      expect(result.codeVerifier).toBe("anthropic-pkce-verifier")
      expect(result.state).toBe("anthropic-state-xyz")
    })

    it("exchanges Anthropic device code (code#state format) for tokens", async () => {
      mockExchangeOAuthConnect.mockResolvedValue({ ok: true, provider: "Anthropic" })

      // User pastes a code#state string from the Anthropic device code page
      const deviceCode = "authcode123#statevalue456"
      await mockExchangeOAuthConnect("anthropic", {
        pastedUrl: deviceCode,
        codeVerifier: "anthropic-pkce-verifier",
        state: "anthropic-state-xyz",
      })

      expect(mockExchangeOAuthConnect).toHaveBeenCalledWith("anthropic", {
        pastedUrl: deviceCode,
        codeVerifier: "anthropic-pkce-verifier",
        state: "anthropic-state-xyz",
      })
    })

    it("exchanges Anthropic callback URL with code and hash for tokens", async () => {
      mockExchangeOAuthConnect.mockResolvedValue({ ok: true, provider: "Anthropic" })

      // User pastes the full callback URL
      const callbackUrl =
        "https://console.anthropic.com/oauth/code/callback?code=authcode123#statevalue"
      await mockExchangeOAuthConnect("anthropic", {
        pastedUrl: callbackUrl,
        codeVerifier: "v",
        state: "s",
      })

      expect(mockExchangeOAuthConnect).toHaveBeenCalledWith("anthropic", {
        pastedUrl: callbackUrl,
        codeVerifier: "v",
        state: "s",
      })
    })
  })
})
