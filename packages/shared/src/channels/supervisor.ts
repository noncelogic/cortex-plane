import { ChannelAdapterRegistry } from "./registry.js"
import type { ChannelAdapter } from "./types.js"

export type ChannelConnectionMode = "long-poll" | "webhook" | "websocket" | "unknown"

export type ChannelHealthState = "healthy" | "unhealthy" | "recovering" | "circuit_open"

export interface ChannelSupervisorAdapterConfig {
  connectionMode?: ChannelConnectionMode
  staleAfterMs?: number
}

export interface ChannelHealthStatus {
  channelType: string
  connectionMode: ChannelConnectionMode
  state: ChannelHealthState
  healthy: boolean
  consecutiveFailures: number
  staleAfterMs: number
  lastProbeAt?: string
  lastHealthyAt?: string
  lastFailureAt?: string
  nextRetryAt?: string
  circuitOpenUntil?: string
  lastError?: string
}

export interface ChannelSupervisorOptions {
  probeIntervalMs: number
  staleAfterMs: number
  initialBackoffMs: number
  maxBackoffMs: number
  jitterRatio: number
  circuitFailureThreshold: number
  circuitOpenMs: number
  random: () => number
  now: () => number
}

const DEFAULT_OPTIONS: ChannelSupervisorOptions = {
  probeIntervalMs: 15_000,
  staleAfterMs: 45_000,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  jitterRatio: 0.2,
  circuitFailureThreshold: 5,
  circuitOpenMs: 60_000,
  random: () => Math.random(),
  now: () => Date.now(),
}

type HealthListener = (statuses: ChannelHealthStatus[]) => void

export class ChannelSupervisor {
  private readonly options: ChannelSupervisorOptions
  private readonly statuses = new Map<string, ChannelHealthStatus>()
  private readonly listeners = new Set<HealthListener>()
  private readonly recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private probeInterval: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(
    private readonly registry: ChannelAdapterRegistry,
    private readonly adapterConfig: Readonly<Record<string, ChannelSupervisorAdapterConfig>> = {},
    options: Partial<ChannelSupervisorOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  start(): void {
    if (this.running) return

    this.running = true
    this.syncAdapters()
    this.emit()
    void this.runProbeCycle()
    this.probeInterval = setInterval(() => {
      void this.runProbeCycle()
    }, this.options.probeIntervalMs)
  }

  stop(): void {
    this.running = false
    if (this.probeInterval) {
      clearInterval(this.probeInterval)
      this.probeInterval = undefined
    }
    for (const timer of this.recoveryTimers.values()) {
      clearTimeout(timer)
    }
    this.recoveryTimers.clear()
  }

  subscribe(listener: HealthListener): () => void {
    this.listeners.add(listener)
    listener(this.getAllStatuses())
    return () => this.listeners.delete(listener)
  }

  getStatus(channelType: string): ChannelHealthStatus | undefined {
    this.syncAdapters()
    const status = this.statuses.get(channelType)
    return status ? { ...status } : undefined
  }

  getAllStatuses(): ChannelHealthStatus[] {
    this.syncAdapters()
    return [...this.statuses.values()]
      .map((status) => ({ ...status }))
      .sort((a, b) => a.channelType.localeCompare(b.channelType))
  }

  private async runProbeCycle(): Promise<void> {
    if (!this.running) return

    this.syncAdapters()
    const adapters = this.registry.getAll()
    await Promise.all(adapters.map((adapter) => this.probeAdapter(adapter)))
  }

  private async probeAdapter(adapter: ChannelAdapter): Promise<void> {
    const { channelType } = adapter
    const status = this.ensureStatus(channelType)
    const nowIso = this.toIso(this.options.now())

    if (status.state === "circuit_open" && status.circuitOpenUntil) {
      const circuitOpenUntilMs = Date.parse(status.circuitOpenUntil)
      if (this.options.now() < circuitOpenUntilMs) {
        return
      }
      status.state = "unhealthy"
      status.circuitOpenUntil = undefined
    }

    let healthy = false
    try {
      healthy = await adapter.healthCheck()
    } catch {
      healthy = false
    }

    status.lastProbeAt = nowIso

    const staleReason = this.getStaleReason(adapter, status)
    if (healthy && !staleReason) {
      status.state = "healthy"
      status.healthy = true
      status.consecutiveFailures = 0
      status.lastHealthyAt = nowIso
      status.lastError = undefined
      status.nextRetryAt = undefined
      status.circuitOpenUntil = undefined
      this.cancelRecovery(channelType)
      this.emit()
      return
    }

    this.recordFailure(channelType, staleReason ?? "health_check_failed")
  }

  private getStaleReason(adapter: ChannelAdapter, status: ChannelHealthStatus): string | undefined {
    if (status.connectionMode !== "long-poll" && status.connectionMode !== "webhook") {
      return undefined
    }

    const heartbeatMs = adapter.getLastHeartbeatAt?.()?.getTime()
    if (heartbeatMs === undefined) {
      return undefined
    }

    const ageMs = this.options.now() - heartbeatMs
    if (ageMs <= status.staleAfterMs) {
      return undefined
    }

    return `stale_connection_${status.connectionMode}`
  }

  private recordFailure(channelType: string, reason: string): void {
    const status = this.ensureStatus(channelType)
    status.state = "unhealthy"
    status.healthy = false
    status.consecutiveFailures += 1
    status.lastFailureAt = this.toIso(this.options.now())
    status.lastError = reason

    if (status.consecutiveFailures >= this.options.circuitFailureThreshold) {
      status.state = "circuit_open"
      status.circuitOpenUntil = this.toIso(this.options.now() + this.options.circuitOpenMs)
      status.nextRetryAt = status.circuitOpenUntil
      this.cancelRecovery(channelType)
      this.emit()
      return
    }

    this.scheduleRecovery(channelType)
    this.emit()
  }

  private scheduleRecovery(channelType: string): void {
    if (!this.running) return
    if (this.recoveryTimers.has(channelType)) return

    const status = this.ensureStatus(channelType)
    const delayMs = this.computeBackoffDelay(status.consecutiveFailures)
    status.nextRetryAt = this.toIso(this.options.now() + delayMs)

    const timer = setTimeout(() => {
      this.recoveryTimers.delete(channelType)
      void this.recoverAdapter(channelType)
    }, delayMs)

    this.recoveryTimers.set(channelType, timer)
  }

  private async recoverAdapter(channelType: string): Promise<void> {
    if (!this.running) return

    const status = this.ensureStatus(channelType)
    if (status.state === "circuit_open") return

    const adapter = this.registry.get(channelType)
    if (!adapter) return

    status.state = "recovering"
    status.healthy = false
    status.nextRetryAt = undefined
    this.emit()

    try {
      await adapter.stop()
      await adapter.start()
      const healthy = await adapter.healthCheck().catch(() => false)
      if (!healthy) {
        this.recordFailure(channelType, "restart_health_check_failed")
        return
      }

      const nowIso = this.toIso(this.options.now())
      status.state = "healthy"
      status.healthy = true
      status.consecutiveFailures = 0
      status.lastHealthyAt = nowIso
      status.lastProbeAt = nowIso
      status.lastError = undefined
      status.lastFailureAt = undefined
      status.nextRetryAt = undefined
      status.circuitOpenUntil = undefined
      this.emit()
    } catch {
      this.recordFailure(channelType, "restart_failed")
    }
  }

  private computeBackoffDelay(consecutiveFailures: number): number {
    const exponent = Math.max(0, consecutiveFailures - 1)
    const baseDelay = Math.min(
      this.options.maxBackoffMs,
      this.options.initialBackoffMs * 2 ** exponent,
    )
    const jitterRange = baseDelay * this.options.jitterRatio
    const jitterOffset = (this.options.random() * 2 - 1) * jitterRange
    return Math.max(0, Math.round(baseDelay + jitterOffset))
  }

  private syncAdapters(): void {
    for (const adapter of this.registry.getAll()) {
      this.ensureStatus(adapter.channelType)
    }
  }

  private ensureStatus(channelType: string): ChannelHealthStatus {
    const existing = this.statuses.get(channelType)
    if (existing) return existing

    const config = this.adapterConfig[channelType]
    const status: ChannelHealthStatus = {
      channelType,
      connectionMode: config?.connectionMode ?? "unknown",
      staleAfterMs: config?.staleAfterMs ?? this.options.staleAfterMs,
      state: "healthy",
      healthy: true,
      consecutiveFailures: 0,
    }
    this.statuses.set(channelType, status)
    return status
  }

  private cancelRecovery(channelType: string): void {
    const timer = this.recoveryTimers.get(channelType)
    if (!timer) return
    clearTimeout(timer)
    this.recoveryTimers.delete(channelType)
  }

  private emit(): void {
    const statuses = this.getAllStatuses()
    for (const listener of this.listeners) {
      listener(statuses)
    }
  }

  private toIso(timestampMs: number): string {
    return new Date(timestampMs).toISOString()
  }
}
