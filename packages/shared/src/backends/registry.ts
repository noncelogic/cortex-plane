/**
 * Backend Registry
 *
 * Central registry for execution backends. Manages backend lookup,
 * lifecycle (start/stop), health check caching, and WIP semaphores.
 *
 * See: docs/spikes/037-execution-backends.md — "Artifact: Backend Registry Pattern"
 */

import type { BackendHealthReport, ExecutionBackend } from "./types.js"

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
  private defaultBackendId: string | undefined

  /**
   * Register a backend. Calls backend.start() to initialize it.
   */
  async register(
    backend: ExecutionBackend,
    config: Record<string, unknown> = {},
    maxConcurrent: number = 1,
  ): Promise<void> {
    if (this.backends.has(backend.backendId)) {
      throw new Error(`Backend '${backend.backendId}' already registered`)
    }

    await backend.start(config)

    this.backends.set(backend.backendId, backend)
    this.healthChecks.set(backend.backendId, new CachedHealthCheck(backend, 30_000))
    this.semaphores.set(backend.backendId, new BackendSemaphore(maxConcurrent))

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

  /** Graceful shutdown — stop all backends. */
  async stopAll(): Promise<void> {
    const stops = [...this.backends.values()].map((b) => b.stop())
    await Promise.allSettled(stops)
    this.backends.clear()
    this.healthChecks.clear()
    this.semaphores.clear()
    this.defaultBackendId = undefined
  }
}
