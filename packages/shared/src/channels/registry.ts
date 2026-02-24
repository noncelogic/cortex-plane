/**
 * Channel Adapter Registry
 *
 * Central registry for channel adapters. Manages adapter lookup,
 * lifecycle (start/stop), and health checks.
 *
 * See: docs/spec.md — Section 15 (Channel Integration)
 */

import type { ChannelAdapter } from "./types.js"

export class ChannelAdapterRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>()

  /** Register a channel adapter. Throws if the channelType is already registered. */
  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.channelType)) {
      throw new Error(`Channel adapter '${adapter.channelType}' already registered`)
    }
    this.adapters.set(adapter.channelType, adapter)
  }

  /** Get a registered adapter by channel type. */
  get(channelType: string): ChannelAdapter | undefined {
    return this.adapters.get(channelType)
  }

  /** Get all registered adapters. */
  getAll(): ChannelAdapter[] {
    return [...this.adapters.values()]
  }

  /** Start all registered adapters. */
  async startAll(): Promise<void> {
    const starts = this.getAll().map((a) => a.start())
    await Promise.all(starts)
  }

  /** Graceful shutdown — stop all registered adapters. */
  async stopAll(): Promise<void> {
    const stops = this.getAll().map((a) => a.stop())
    await Promise.allSettled(stops)
  }

  /** Health check all registered adapters. Returns a map of channelType → healthy. */
  async healthCheckAll(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>()
    const entries = [...this.adapters.entries()]
    const checks = await Promise.allSettled(entries.map(([, a]) => a.healthCheck()))
    for (let i = 0; i < entries.length; i++) {
      const [type] = entries[i]!
      const result = checks[i]!
      results.set(type, result.status === "fulfilled" ? result.value : false)
    }
    return results
  }
}
