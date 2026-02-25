/**
 * Backend Registry
 *
 * Central registry for execution backends. Manages backend lookup,
 * lifecycle (start/stop), health check caching, and WIP semaphores.
 *
 * See: docs/spikes/037-execution-backends.md — "Artifact: Backend Registry Pattern"
 */

import { CircuitBreaker, type CircuitBreakerConfig, type CircuitState, type CircuitStats } from "./circuit-breaker.js"
import { ProviderRouter, type RouteResult } from "./provider-router.js"
import type { BackendHealthReport, ExecutionBackend, ExecutionTask } from "./types.js"

// ──────────────────────────────────────────────────
// Semaphore for WIP Limiting
// ──────────────────────────────────────────────────

export interface SemaphoreRelease {
  release(): void
}

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
}

export class BackendSemaphore {
  private active = 0
  private readonly waiters: Waiter[] = []

  constructor(private readonly maxConcurrent: number) {}

  async acquire(timeoutMs: number): Promise<SemaphoreRelease> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return { release: () => this.release() }
    }

    return new Promise<SemaphoreRelease>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(timer)
          this.active++
          resolve({ release: () => this.release() })
        },
        reject,
      }

      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter)
        if (idx !== -1) this.waiters.splice(idx, 1)
        reject(new Error(`Backend semaphore timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      this.waiters.push(waiter)
    })
  }

  private release(): void {
    this.active--
    const next = this.waiters.shift()
    if (next) {
      next.resolve()
    }
  }

  get available(): number {
    return this.maxConcurrent - this.active
  }

  get currentActive(): number {
    return this.active
  }
}

// ──────────────────────────────────────────────────
// Cached Health Check
// ──────────────────────────────────────────────────

export class CachedHealthCheck {
  private cache: BackendHealthReport | null = null

  constructor(
    private readonly backend: ExecutionBackend,
    private readonly ttlMs: number = 30_000,
  ) {}

  async check(): Promise<BackendHealthReport> {
    if (this.cache && Date.now() - new Date(this.cache.checkedAt).getTime() < this.ttlMs) {
      return this.cache
    }
    this.cache = await this.backend.healthCheck()
    return this.cache
  }

  invalidate(): void {
    this.cache = null
  }
}

// ──────────────────────────────────────────────────
// Backend Registry
// ──────────────────────────────────────────────────

export class BackendRegistry {
  private readonly backends = new Map<string, ExecutionBackend>()
  private readonly healthChecks = new Map<string, CachedHealthCheck>()
  private readonly semaphores = new Map<string, BackendSemaphore>()
  private readonly circuitBreakers = new Map<string, CircuitBreaker>()
  private readonly circuitBreakerConfigs = new Map<string, Partial<CircuitBreakerConfig> | undefined>()
  private defaultBackendId: string | undefined
  private router: ProviderRouter | undefined

  /**
   * Register a backend. Calls backend.start() to initialize it.
   */
  async register(
    backend: ExecutionBackend,
    config: Record<string, unknown> = {},
    maxConcurrent: number = 1,
    circuitBreakerConfig?: Partial<CircuitBreakerConfig>,
  ): Promise<void> {
    if (this.backends.has(backend.backendId)) {
      throw new Error(`Backend '${backend.backendId}' already registered`)
    }

    await backend.start(config)

    this.backends.set(backend.backendId, backend)
    this.healthChecks.set(backend.backendId, new CachedHealthCheck(backend, 30_000))
    this.semaphores.set(backend.backendId, new BackendSemaphore(maxConcurrent))
    this.circuitBreakers.set(backend.backendId, new CircuitBreaker(circuitBreakerConfig))
    this.circuitBreakerConfigs.set(backend.backendId, circuitBreakerConfig)

    if (!this.defaultBackendId) {
      this.defaultBackendId = backend.backendId
    }
  }

  /** Get a registered backend by ID. */
  get(backendId: string): ExecutionBackend | undefined {
    return this.backends.get(backendId)
  }

  /** Get the first registered backend (default). */
  getDefault(): ExecutionBackend | undefined {
    if (!this.defaultBackendId) return undefined
    return this.backends.get(this.defaultBackendId)
  }

  /** Get cached health status for a backend. */
  async getHealth(backendId: string): Promise<BackendHealthReport | undefined> {
    const check = this.healthChecks.get(backendId)
    return check?.check()
  }

  /** Get all backend health statuses. */
  async getAllHealth(): Promise<BackendHealthReport[]> {
    const reports: BackendHealthReport[] = []
    for (const [, check] of this.healthChecks) {
      reports.push(await check.check())
    }
    return reports
  }

  /** Acquire a WIP semaphore permit for a backend. */
  async acquirePermit(backendId: string, timeoutMs: number): Promise<SemaphoreRelease> {
    const semaphore = this.semaphores.get(backendId)
    if (!semaphore) {
      throw new Error(`No semaphore for backend '${backendId}'`)
    }
    return semaphore.acquire(timeoutMs)
  }

  /** Invalidate the health cache for a backend. */
  invalidateHealth(backendId: string): void {
    this.healthChecks.get(backendId)?.invalidate()
  }

  /** List all registered backend IDs. */
  list(): string[] {
    return [...this.backends.keys()]
  }

  // ── Circuit Breaker & Router Integration ──

  /** Get the circuit breaker for a specific backend. */
  getCircuitBreaker(backendId: string): CircuitBreaker | undefined {
    return this.circuitBreakers.get(backendId)
  }

  /** Get circuit states for all registered backends. */
  getCircuitStates(): Map<string, CircuitState> {
    const states = new Map<string, CircuitState>()
    for (const [id, breaker] of this.circuitBreakers) {
      states.set(id, breaker.getState())
    }
    return states
  }

  /** Get circuit stats for all registered backends. */
  getCircuitStats(): Map<string, CircuitStats> {
    const stats = new Map<string, CircuitStats>()
    for (const [id, breaker] of this.circuitBreakers) {
      stats.set(id, breaker.getStats())
    }
    return stats
  }

  /**
   * Configure the provider router for failover-aware dispatch.
   * Registers all current backends with the router in registration order.
   */
  configureRouter(router?: ProviderRouter): ProviderRouter {
    if (router) {
      this.router = router
      return router
    }

    this.router = new ProviderRouter()
    let priority = 0
    for (const [backendId, backend] of this.backends) {
      this.router.addProvider({
        providerId: backendId,
        backend,
        priority: priority++,
        circuitBreakerConfig: this.circuitBreakerConfigs.get(backendId),
      })
    }
    return this.router
  }

  /** Get the configured router (if any). */
  getRouter(): ProviderRouter | undefined {
    return this.router
  }

  /**
   * Route a task using the provider router with failover.
   * Falls back to direct registry.get() / getDefault() if no router is configured.
   */
  routeTask(task: ExecutionTask, preferredBackendId?: string): RouteResult {
    if (this.router) {
      return this.router.route(task)
    }

    // Fallback: no router configured — use direct lookup
    const backend = preferredBackendId
      ? this.backends.get(preferredBackendId)
      : this.getDefault()

    if (!backend) {
      throw new Error(
        `No execution backend available${preferredBackendId ? ` (requested: ${preferredBackendId})` : ""}`,
      )
    }

    return { backend, providerId: backend.backendId }
  }

  /** Record an execution outcome for the circuit breaker. */
  recordOutcome(providerId: string, success: boolean, classification?: string): void {
    // Update router if configured
    if (this.router) {
      this.router.recordOutcome(providerId, success, classification)
      return
    }

    // Otherwise update circuit breaker directly
    const breaker = this.circuitBreakers.get(providerId)
    if (!breaker) return

    if (success) {
      breaker.recordSuccess()
    } else {
      breaker.recordFailure(classification ?? "transient")
    }
  }

  /** Graceful shutdown — stop all backends. */
  async stopAll(): Promise<void> {
    const stops = [...this.backends.values()].map((b) => b.stop())
    await Promise.allSettled(stops)
    this.backends.clear()
    this.healthChecks.clear()
    this.semaphores.clear()
    this.circuitBreakers.clear()
    this.circuitBreakerConfigs.clear()
    this.defaultBackendId = undefined
    this.router = undefined
  }
}
