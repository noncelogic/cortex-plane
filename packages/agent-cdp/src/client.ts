import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import type { ActionResult, BrowserAction, CdpClientConfig, Observation } from "./types.js"

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 9222
const DEFAULT_ASSET_DIR = "/workspace/browser"
const DEFAULT_MAX_RETRIES = 10
const DEFAULT_RETRY_BASE_DELAY_MS = 500

/**
 * CDP client wrapper that communicates with the Playwright sidecar container.
 *
 * Implements the Observe-Think-Act loop primitives:
 * - `observe()`: Navigate → screenshot + DOM snapshot
 * - `act()`:     Execute targeted actions (click, fill, navigate, etc.)
 *
 * Handles connection drops with exponential-backoff reconnection.
 */
export class CdpClient {
  private readonly host: string
  private readonly port: number
  private readonly assetDir: string
  private readonly maxRetries: number
  private readonly retryBaseDelayMs: number

  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private screenshotCounter = 0

  constructor(config: CdpClientConfig = {}) {
    this.host = config.host ?? DEFAULT_HOST
    this.port = config.port ?? DEFAULT_PORT
    this.assetDir = config.assetDir ?? DEFAULT_ASSET_DIR
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS
  }

  /** Connect to the CDP sidecar. Retries with exponential backoff on failure. */
  async connect(): Promise<void> {
    await this.ensureAssetDir()
    this.browser = await this.connectWithRetry()
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    })
    this.page = await this.context.newPage()
  }

  /** Gracefully disconnect from the CDP sidecar. */
  async disconnect(): Promise<void> {
    try {
      await this.context?.close()
    } catch {
      // context may already be closed
    }
    try {
      await this.browser?.close()
    } catch {
      // browser may already be disconnected
    }
    this.page = null
    this.context = null
    this.browser = null
  }

  /**
   * Navigate to URL and capture an observation (screenshot + DOM snapshot).
   * If the connection is lost, reconnects before retrying.
   */
  async observe(url?: string): Promise<Observation> {
    const page = await this.ensurePage()

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    }

    const [screenshotPath, domSnapshot, pageUrl, title] = await Promise.all([
      this.captureScreenshot(page),
      this.captureDom(page),
      page.url(),
      page.title(),
    ])

    return {
      screenshotPath,
      domSnapshot,
      url: pageUrl,
      title,
      timestamp: new Date().toISOString(),
    }
  }

  /** Execute a browser action. Reconnects on connection drop. */
  async act(action: BrowserAction): Promise<ActionResult> {
    try {
      const page = await this.ensurePage()
      return await this.executeAction(page, action)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      // Connection-related errors trigger reconnection
      if (this.isConnectionError(message)) {
        await this.reconnect()
        try {
          const page = await this.ensurePage()
          return await this.executeAction(page, action)
        } catch (retryErr) {
          return {
            success: false,
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          }
        }
      }

      return { success: false, error: message }
    }
  }

  /** Check if the CDP sidecar is reachable. */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`http://${this.host}:${this.port}/json/version`)
      return res.ok
    } catch {
      return false
    }
  }

  /** Get the current page instance (for advanced use). */
  getPage(): Page | null {
    return this.page
  }

  // ---------------------------------------------------------------------------
  // Private: Connection management
  // ---------------------------------------------------------------------------

  private async connectWithRetry(): Promise<Browser> {
    let attempt = 0
    while (attempt < this.maxRetries) {
      try {
        const wsEndpoint = await this.discoverWsEndpoint()
        return await chromium.connectOverCDP(wsEndpoint)
      } catch (err) {
        attempt++
        if (attempt >= this.maxRetries) {
          throw new Error(
            `Failed to connect to CDP sidecar at ${this.host}:${this.port} after ${this.maxRetries} attempts: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const delay = this.retryBaseDelayMs * 2 ** (attempt - 1)
        await sleep(delay)
      }
    }
    // unreachable, but TypeScript needs it
    throw new Error("Exhausted retries")
  }

  private async discoverWsEndpoint(): Promise<string> {
    const res = await fetch(`http://${this.host}:${this.port}/json/version`)
    if (!res.ok) {
      throw new Error(`CDP version endpoint returned ${res.status}`)
    }
    const data = (await res.json()) as { webSocketDebuggerUrl?: string }
    if (!data.webSocketDebuggerUrl) {
      throw new Error("No webSocketDebuggerUrl in CDP /json/version response")
    }
    return data.webSocketDebuggerUrl
  }

  private async reconnect(): Promise<void> {
    await this.disconnect()
    await this.connect()
  }

  private async ensurePage(): Promise<Page> {
    if (!this.page || !this.browser?.isConnected()) {
      await this.reconnect()
    }
    if (!this.page) {
      throw new Error("Failed to establish page after reconnection")
    }
    return this.page
  }

  private isConnectionError(message: string): boolean {
    const patterns = [
      "Target closed",
      "target closed",
      "Browser closed",
      "browser has been closed",
      "Protocol error",
      "Connection refused",
      "ECONNREFUSED",
      "ECONNRESET",
      "WebSocket error",
    ]
    return patterns.some((p) => message.includes(p))
  }

  // ---------------------------------------------------------------------------
  // Private: Observation
  // ---------------------------------------------------------------------------

  private async captureScreenshot(page: Page): Promise<string> {
    this.screenshotCounter++
    const filename = `screenshot-${this.screenshotCounter}-${Date.now()}.png`
    const filePath = path.join(this.assetDir, filename)
    await page.screenshot({ path: filePath, fullPage: false })
    return filePath
  }

  private async captureDom(page: Page): Promise<string> {
    return page.content()
  }

  private async ensureAssetDir(): Promise<void> {
    await fs.mkdir(this.assetDir, { recursive: true })
  }

  // ---------------------------------------------------------------------------
  // Private: Action execution
  // ---------------------------------------------------------------------------

  private async executeAction(page: Page, action: BrowserAction): Promise<ActionResult> {
    switch (action.type) {
      case "navigate":
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30_000 })
        return { success: true }

      case "click":
        await page.click(action.selector, { timeout: 10_000 })
        return { success: true }

      case "fill":
        await page.fill(action.selector, action.value, { timeout: 10_000 })
        return { success: true }

      case "screenshot": {
        const screenshotPath = await this.captureScreenshot(page)
        return { success: true, screenshotPath }
      }

      case "wait":
        await page.waitForTimeout(action.ms)
        return { success: true }

      case "scroll":
        await page.evaluate(
          ({ direction, amount }) => {
            const delta = amount ?? 300
            const w = globalThis as unknown as { scrollBy(x: number, y: number): void }
            w.scrollBy(0, direction === "down" ? delta : -delta)
          },
          { direction: action.direction, amount: action.amount },
        )
        return { success: true }

      case "keypress":
        await page.keyboard.press(action.key)
        return { success: true }

      default: {
        const _exhaustive: never = action
        return { success: false, error: `Unknown action type: ${JSON.stringify(_exhaustive)}` }
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
