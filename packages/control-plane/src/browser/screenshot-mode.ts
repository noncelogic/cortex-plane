/**
 * Screenshot Mode — Low-Bandwidth Fallback
 *
 * When VNC is unavailable or bandwidth is limited, this module provides
 * periodic screenshot capture with diff detection to skip unchanged frames.
 */

import { createHash } from "node:crypto"
import type { ScreenshotFrame, ScreenshotStreamConfig } from "@cortex/shared/browser"
import type { BrowserObservationService } from "../observation/service.js"

const DEFAULT_INTERVAL_MS = 2_000
const DEFAULT_FORMAT = "jpeg" as const
const DEFAULT_QUALITY = 60

// ---------------------------------------------------------------------------
// Screenshot Stream State
// ---------------------------------------------------------------------------

interface AgentScreenshotState {
  timer: ReturnType<typeof setInterval> | null
  lastHash: string | null
  config: ScreenshotStreamConfig
  listeners: Set<(frame: ScreenshotFrame) => void>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ScreenshotModeService {
  private readonly agents = new Map<string, AgentScreenshotState>()
  private readonly observationService: BrowserObservationService

  constructor(observationService: BrowserObservationService) {
    this.observationService = observationService
  }

  /**
   * Start periodic screenshot capture for an agent.
   */
  start(agentId: string, config?: Partial<ScreenshotStreamConfig>): ScreenshotStreamConfig {
    const existing = this.agents.get(agentId)
    if (existing?.timer) {
      // Already running — update config if provided
      if (config) {
        existing.config = { ...existing.config, ...config }
      }
      return existing.config
    }

    const streamConfig: ScreenshotStreamConfig = {
      intervalMs: config?.intervalMs ?? DEFAULT_INTERVAL_MS,
      format: config?.format ?? DEFAULT_FORMAT,
      quality: config?.quality ?? DEFAULT_QUALITY,
    }

    const state: AgentScreenshotState = {
      timer: null,
      lastHash: null,
      config: streamConfig,
      listeners: new Set(),
    }

    state.timer = setInterval(() => {
      void this.captureAndDiff(agentId, state)
    }, streamConfig.intervalMs)

    this.agents.set(agentId, state)
    return streamConfig
  }

  /**
   * Stop periodic screenshot capture for an agent.
   */
  stop(agentId: string): void {
    const state = this.agents.get(agentId)
    if (!state) return

    if (state.timer) {
      clearInterval(state.timer)
      state.timer = null
    }
    state.listeners.clear()
    this.agents.delete(agentId)
  }

  /**
   * Check if screenshot mode is active for an agent.
   */
  isActive(agentId: string): boolean {
    return this.agents.get(agentId)?.timer != null
  }

  /**
   * Get current configuration for an agent.
   */
  getConfig(agentId: string): ScreenshotStreamConfig | null {
    return this.agents.get(agentId)?.config ?? null
  }

  /**
   * Register a listener for new screenshot frames.
   */
  onFrame(agentId: string, listener: (frame: ScreenshotFrame) => void): () => void {
    let state = this.agents.get(agentId)
    if (!state) {
      // Create state without starting the timer
      state = {
        timer: null,
        lastHash: null,
        config: { intervalMs: DEFAULT_INTERVAL_MS, format: DEFAULT_FORMAT, quality: DEFAULT_QUALITY },
        listeners: new Set(),
      }
      this.agents.set(agentId, state)
    }
    state.listeners.add(listener)
    return () => { state.listeners.delete(listener) }
  }

  /**
   * Shut down all screenshot streams.
   */
  shutdown(): void {
    for (const agentId of this.agents.keys()) {
      this.stop(agentId)
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async captureAndDiff(agentId: string, state: AgentScreenshotState): Promise<void> {
    try {
      const result = await this.observationService.captureScreenshot(agentId, {
        format: state.config.format,
        quality: state.config.quality,
      })

      const hash = hashScreenshot(result.data)
      const changed = hash !== state.lastHash
      state.lastHash = hash

      const frame: ScreenshotFrame = {
        agentId,
        data: result.data,
        format: result.format,
        width: result.width,
        height: result.height,
        timestamp: result.timestamp,
        url: result.url,
        changed,
      }

      // Only notify listeners if frame changed (or it's the first frame)
      if (changed) {
        for (const listener of state.listeners) {
          try {
            listener(frame)
          } catch {
            // swallow listener errors
          }
        }
      }
    } catch {
      // Capture failed — skip this frame silently
    }
  }
}

/**
 * Hash screenshot data for diff detection.
 * Uses SHA-256 truncated to 16 hex chars for speed.
 */
export function hashScreenshot(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16)
}
