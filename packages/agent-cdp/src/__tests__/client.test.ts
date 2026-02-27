import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CdpClientConfig } from "../types.js"

// ---------------------------------------------------------------------------
// vi.hoisted ensures these are available when vi.mock factories execute
// ---------------------------------------------------------------------------
const { mockPage, mockContext, mockBrowser, mockConnectOverCDP, mockFetch } = vi.hoisted(() => {
  const mockPage = {
    screenshot: vi.fn(),
    content: vi.fn(),
    goto: vi.fn(),
    click: vi.fn(),
    fill: vi.fn(),
    waitForTimeout: vi.fn(),
    evaluate: vi.fn(),
    keyboard: { press: vi.fn() },
    url: vi.fn(),
    title: vi.fn(),
    close: vi.fn(),
  }

  const mockContext = {
    newPage: vi.fn(),
    close: vi.fn(),
  }

  const mockBrowser = {
    newContext: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(),
  }

  const mockConnectOverCDP = vi.fn()
  const mockFetch = vi.fn()

  return { mockPage, mockContext, mockBrowser, mockConnectOverCDP, mockFetch }
})

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: mockConnectOverCDP,
  },
}))

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
  }
})

vi.stubGlobal("fetch", mockFetch)

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------
function resetMockDefaults(): void {
  mockConnectOverCDP.mockResolvedValue(mockBrowser)
  mockBrowser.newContext.mockResolvedValue(mockContext)
  mockBrowser.close.mockResolvedValue(undefined)
  mockBrowser.isConnected.mockReturnValue(true)
  mockContext.newPage.mockResolvedValue(mockPage)
  mockContext.close.mockResolvedValue(undefined)
  mockPage.screenshot.mockResolvedValue(Buffer.from("fake-png"))
  mockPage.content.mockResolvedValue("<html><body>hello</body></html>")
  mockPage.goto.mockResolvedValue(undefined)
  mockPage.click.mockResolvedValue(undefined)
  mockPage.fill.mockResolvedValue(undefined)
  mockPage.waitForTimeout.mockResolvedValue(undefined)
  mockPage.evaluate.mockResolvedValue(undefined)
  mockPage.keyboard.press.mockResolvedValue(undefined)
  mockPage.url.mockReturnValue("https://example.com")
  mockPage.title.mockReturnValue("Example")
  mockPage.close.mockResolvedValue(undefined)

  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc-123",
    }),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
import { CdpClient } from "../client.js"
import * as fs from "node:fs/promises"

const testConfig: CdpClientConfig = {
  host: "127.0.0.1",
  port: 9222,
  assetDir: "/tmp/test-browser-assets",
  maxRetries: 3,
  retryBaseDelayMs: 10,
}

describe("CdpClient", () => {
  let client: CdpClient

  beforeEach(() => {
    vi.clearAllMocks()
    resetMockDefaults()
    client = new CdpClient(testConfig)
  })

  afterEach(async () => {
    await client.disconnect()
  })

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------
  describe("connect", () => {
    it("connects to CDP sidecar via WebSocket endpoint", async () => {
      await client.connect()

      expect(mockFetch).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version")
      expect(mockConnectOverCDP).toHaveBeenCalledWith(
        "ws://127.0.0.1:9222/devtools/browser/abc-123",
      )
    })

    it("creates asset directory on connect", async () => {
      await client.connect()
      expect(fs.mkdir).toHaveBeenCalledWith("/tmp/test-browser-assets", { recursive: true })
    })

    it("retries connection on failure with exponential backoff", async () => {
      mockConnectOverCDP
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(mockBrowser)

      await client.connect()

      expect(mockConnectOverCDP).toHaveBeenCalledTimes(3)
    })

    it("throws after exhausting retries", async () => {
      mockConnectOverCDP.mockRejectedValue(new Error("ECONNREFUSED"))

      await expect(client.connect()).rejects.toThrow(
        /Failed to connect to CDP sidecar.*after 3 attempts/,
      )
    })
  })

  // -------------------------------------------------------------------------
  // Health check
  // -------------------------------------------------------------------------
  describe("isHealthy", () => {
    it("returns true when CDP endpoint responds", async () => {
      const healthy = await client.isHealthy()
      expect(healthy).toBe(true)
    })

    it("returns false when CDP endpoint is unreachable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"))
      const healthy = await client.isHealthy()
      expect(healthy).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Observe
  // -------------------------------------------------------------------------
  describe("observe", () => {
    it("navigates to URL and captures screenshot + DOM", async () => {
      await client.connect()
      const observation = await client.observe("https://example.com")

      expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      expect(observation.screenshotPath).toMatch(/screenshot-1-\d+\.png$/)
      expect(observation.domSnapshot).toBe("<html><body>hello</body></html>")
      expect(observation.url).toBe("https://example.com")
      expect(observation.title).toBe("Example")
      expect(observation.timestamp).toBeDefined()
    })

    it("captures current page without navigation when no URL", async () => {
      await client.connect()
      await client.observe()

      expect(mockPage.goto).not.toHaveBeenCalled()
    })

    it("stores screenshots in the configured asset directory", async () => {
      await client.connect()
      const observation = await client.observe()

      expect(observation.screenshotPath).toContain("/tmp/test-browser-assets/")
      expect(mockPage.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({
          path: expect.stringContaining("/tmp/test-browser-assets/screenshot-"),
          fullPage: false,
        }),
      )
    })

    it("increments screenshot counter for unique filenames", async () => {
      await client.connect()
      const obs1 = await client.observe()
      const obs2 = await client.observe()

      expect(obs1.screenshotPath).toMatch(/screenshot-1-/)
      expect(obs2.screenshotPath).toMatch(/screenshot-2-/)
    })
  })

  // -------------------------------------------------------------------------
  // Act
  // -------------------------------------------------------------------------
  describe("act", () => {
    beforeEach(async () => {
      await client.connect()
    })

    it("executes navigate action", async () => {
      const result = await client.act({ type: "navigate", url: "https://example.com" })

      expect(result.success).toBe(true)
      expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
    })

    it("executes click action", async () => {
      const result = await client.act({ type: "click", selector: "#submit" })

      expect(result.success).toBe(true)
      expect(mockPage.click).toHaveBeenCalledWith("#submit", { timeout: 10_000 })
    })

    it("executes fill action", async () => {
      const result = await client.act({
        type: "fill",
        selector: "#email",
        value: "test@example.com",
      })

      expect(result.success).toBe(true)
      expect(mockPage.fill).toHaveBeenCalledWith("#email", "test@example.com", { timeout: 10_000 })
    })

    it("executes screenshot action and returns path", async () => {
      const result = await client.act({ type: "screenshot" })

      expect(result.success).toBe(true)
      expect(result.screenshotPath).toMatch(/screenshot-\d+-\d+\.png$/)
    })

    it("executes wait action", async () => {
      const result = await client.act({ type: "wait", ms: 1000 })

      expect(result.success).toBe(true)
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(1000)
    })

    it("executes scroll action", async () => {
      const result = await client.act({ type: "scroll", direction: "down", amount: 500 })

      expect(result.success).toBe(true)
      expect(mockPage.evaluate).toHaveBeenCalled()
    })

    it("executes keypress action", async () => {
      const result = await client.act({ type: "keypress", key: "Enter" })

      expect(result.success).toBe(true)
      expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter")
    })

    it("returns error for failed actions", async () => {
      mockPage.click.mockRejectedValueOnce(new Error("Element not found"))

      const result = await client.act({ type: "click", selector: "#nonexistent" })

      expect(result.success).toBe(false)
      expect(result.error).toBe("Element not found")
    })
  })

  // -------------------------------------------------------------------------
  // Connection recovery
  // -------------------------------------------------------------------------
  describe("connection recovery", () => {
    it("reconnects on connection drop during act()", async () => {
      await client.connect()

      mockPage.click
        .mockRejectedValueOnce(new Error("Target closed"))
        .mockResolvedValueOnce(undefined)

      const result = await client.act({ type: "click", selector: "#btn" })

      expect(result.success).toBe(true)
    })

    it("reconnects when browser is disconnected during observe()", async () => {
      await client.connect()

      mockBrowser.isConnected.mockReturnValueOnce(false)

      const observation = await client.observe()
      expect(observation.url).toBe("https://example.com")
    })

    it("returns error when reconnection also fails during act()", async () => {
      await client.connect()

      mockPage.click.mockRejectedValue(new Error("Target closed"))

      const result = await client.act({ type: "click", selector: "#btn" })

      expect(result.success).toBe(false)
      expect(result.error).toContain("Target closed")
    })
  })

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------
  describe("disconnect", () => {
    it("closes context and browser", async () => {
      await client.connect()
      await client.disconnect()

      expect(mockContext.close).toHaveBeenCalled()
      expect(mockBrowser.close).toHaveBeenCalled()
    })

    it("handles disconnect when not connected", async () => {
      await expect(client.disconnect()).resolves.toBeUndefined()
    })

    it("handles errors during disconnect gracefully", async () => {
      await client.connect()
      mockContext.close.mockRejectedValueOnce(new Error("already closed"))
      mockBrowser.close.mockRejectedValueOnce(new Error("already closed"))

      await expect(client.disconnect()).resolves.toBeUndefined()
    })
  })
})
