/** Configuration for connecting to the Playwright CDP sidecar. */
export interface CdpClientConfig {
  /** CDP endpoint hostname. Defaults to "127.0.0.1". */
  host?: string
  /** CDP endpoint port. Defaults to 9222. */
  port?: number
  /** Directory for storing screenshots and assets. Defaults to "/workspace/browser". */
  assetDir?: string
  /** Maximum connection retry attempts before throwing. Defaults to 10. */
  maxRetries?: number
  /** Base delay (ms) between retries, doubled each attempt. Defaults to 500. */
  retryBaseDelayMs?: number
}

/** Result of a page observation (screenshot + DOM snapshot). */
export interface Observation {
  /** Absolute path to the screenshot PNG file. */
  screenshotPath: string
  /** Serialised DOM snapshot as HTML string. */
  domSnapshot: string
  /** Page URL at time of observation. */
  url: string
  /** Page title at time of observation. */
  title: string
  /** Timestamp of observation (ISO 8601). */
  timestamp: string
}

/** Actions the agent can execute against the browser. */
export type BrowserAction =
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "navigate"; url: string }
  | { type: "screenshot" }
  | { type: "wait"; ms: number }
  | { type: "scroll"; direction: "up" | "down"; amount?: number }
  | { type: "keypress"; key: string }

/** Result of executing a browser action. */
export interface ActionResult {
  success: boolean
  error?: string
  /** For screenshot actions, path to the resulting file. */
  screenshotPath?: string
}
