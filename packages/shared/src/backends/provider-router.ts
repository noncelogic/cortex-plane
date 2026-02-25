/**
 * Provider Router
 *
 * Routes execution requests across multiple backends with failover.
 * Uses circuit breakers to skip unhealthy providers and tries the
 * next provider in priority order on failure.
 *
 * See: docs/issues/098-multi-provider-routing.md
 */

import { CircuitBreaker, type CircuitBreakerConfig, type CircuitState } from "./circuit-breaker.js"
import type { ExecutionBackend, ExecutionTask } from "./types.js"

// ──────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────

export interface ProviderEntry {
  providerId: string
  backend: ExecutionBackend
  priority: number
  circuitBreakerConfig?: Partial<CircuitBreakerConfig>
}

export interface RouteResult {
  backend: ExecutionBackend
  providerId: string
}

export interface RoutingEvent {
  type: "route_selected" | "route_failover" | "route_skipped" | "route_exhausted"
  providerId: string
  reason?: string
  timestamp: string
}

export type RoutingEventListener = (event: RoutingEvent) => void

// ──────────────────────────────────────────────────
// Provider Router
// ──────────────────────────────────────────────────

export class ProviderRouter {
  private readonly providers: ProviderEntry[] = []
  private readonly breakers = new Map<string, CircuitBreaker>()
  private readonly listeners: RoutingEventListener[] = []
  private readonly now: () => number

  constructor(now?: () => number) {
    this.now = now ?? Date.now
  }

  addProvider(entry: ProviderEntry): void {
    this.providers.push(entry)
    // Keep sorted by priority (lower = higher priority)
    this.providers.sort((a, b) => a.priority - b.priority)

    if (!this.breakers.has(entry.providerId)) {
      this.breakers.set(
        entry.providerId,
        new CircuitBreaker(entry.circuitBreakerConfig, this.now),
      )
    }
  }

  route(_task: ExecutionTask): RouteResult {
    const sorted = this.providers

    for (const entry of sorted) {
      const breaker = this.breakers.get(entry.providerId)!
      const state = breaker.getState()

      if (state === "OPEN") {
        this.emit({
          type: "route_skipped",
          providerId: entry.providerId,
          reason: "circuit_open",
          timestamp: new Date(this.now()).toISOString(),
        })
        continue
      }

      if (state === "HALF_OPEN" && !breaker.canExecute()) {
        this.emit({
          type: "route_skipped",
          providerId: entry.providerId,
          reason: "half_open_at_capacity",
          timestamp: new Date(this.now()).toISOString(),
        })
        continue
      }

      // Acquire half-open slot if needed
      if (state === "HALF_OPEN") {
        breaker.acquireHalfOpenSlot()
      }

      this.emit({
        type: "route_selected",
        providerId: entry.providerId,
        timestamp: new Date(this.now()).toISOString(),
      })

      return { backend: entry.backend, providerId: entry.providerId }
    }

    // All circuits are open
    this.emit({
      type: "route_exhausted",
      providerId: "",
      reason: "all_circuits_open",
      timestamp: new Date(this.now()).toISOString(),
    })

    throw new Error("All provider circuits are open — no backend available for execution")
  }

  routeWithFailover(task: ExecutionTask): RouteResult {
    const sorted = this.providers
    const skipped: string[] = []

    for (const entry of sorted) {
      const breaker = this.breakers.get(entry.providerId)!
      const state = breaker.getState()

      if (state === "OPEN") {
        this.emit({
          type: "route_skipped",
          providerId: entry.providerId,
          reason: "circuit_open",
          timestamp: new Date(this.now()).toISOString(),
        })
        skipped.push(entry.providerId)
        continue
      }

      if (state === "HALF_OPEN" && !breaker.canExecute()) {
        this.emit({
          type: "route_skipped",
          providerId: entry.providerId,
          reason: "half_open_at_capacity",
          timestamp: new Date(this.now()).toISOString(),
        })
        skipped.push(entry.providerId)
        continue
      }

      if (state === "HALF_OPEN") {
        breaker.acquireHalfOpenSlot()
      }

      if (skipped.length > 0) {
        this.emit({
          type: "route_failover",
          providerId: entry.providerId,
          reason: `failover from ${skipped[skipped.length - 1]}`,
          timestamp: new Date(this.now()).toISOString(),
        })
      } else {
        this.emit({
          type: "route_selected",
          providerId: entry.providerId,
          timestamp: new Date(this.now()).toISOString(),
        })
      }

      return { backend: entry.backend, providerId: entry.providerId }
    }

    this.emit({
      type: "route_exhausted",
      providerId: "",
      reason: "all_circuits_open",
      timestamp: new Date(this.now()).toISOString(),
    })

    throw new Error("All provider circuits are open — no backend available for execution")
  }

  recordOutcome(providerId: string, success: boolean, classification?: string): void {
    const breaker = this.breakers.get(providerId)
    if (!breaker) return

    if (success) {
      breaker.recordSuccess()
    } else {
      breaker.recordFailure(classification ?? "transient")
    }
  }

  getCircuitStates(): Map<string, CircuitState> {
    const states = new Map<string, CircuitState>()
    for (const [id, breaker] of this.breakers) {
      states.set(id, breaker.getState())
    }
    return states
  }

  getCircuitBreaker(providerId: string): CircuitBreaker | undefined {
    return this.breakers.get(providerId)
  }

  onRoutingEvent(listener: RoutingEventListener): void {
    this.listeners.push(listener)
  }

  getProviderIds(): string[] {
    return this.providers.map((p) => p.providerId)
  }

  private emit(event: RoutingEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
