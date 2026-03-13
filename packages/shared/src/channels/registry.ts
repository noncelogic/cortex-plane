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

  /** Register a channel adapter, starting it before adding to the registry. Throws if the channelType is already registered. */
  async register(adapter: ChannelAdapter): Promise<void> {
    if (this.adapters.has(adapter.channelType)) {
      throw new Error(`Channel adapter '${adapter.channelType}' already registered`)
    }
    await adapter.start()
    this.adapters.set(adapter.channelType, adapter)
  }

  /** Replace an existing adapter or register a new one. Stops the old adapter, starts the new one. */
  async replace(adapter: ChannelAdapter): Promise<ChannelAdapter | undefined> {
    const existing = this.adapters.get(adapter.channelType)
    if (existing) {
      await existing.stop()
    }
    await adapter.start()
    this.adapters.set(adapter.channelType, adapter)
    return existing
  }

  /** Remove and stop an adapter by channel type. Returns the removed adapter, or undefined. */
  async remove(channelType: string): Promise<ChannelAdapter | undefined> {
    const adapter = this.adapters.get(channelType)
    if (adapter) {
      await adapter.stop()
      this.adapters.delete(channelType)
    }
    return adapter
  }

  /** Get a registered adapter by channel type. */
  get(channelType: string): ChannelAdapter | undefined {
    return this.adapters.get(channelType)
  }

  /** Get all registered adapters. */
  getAll(): ChannelAdapter[] {
    return [...this.adapters.values()]
  }

  /** @deprecated No-op — adapters are now started on register(). Kept for backward compatibility. */
  async startAll(): Promise<void> {
    // No-op: each adapter is started inside register() / replace().
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
