/**
 * AgentLifecycleManager — orchestrates the full agent lifecycle.
 *
 * Coordinates state machine transitions, K8s deployment, hydration,
 * health monitoring, and idle detection into a single interface
 * consumed by the control plane API and Graphile Worker tasks.
 *
 * Operations:
 * - boot(agentId, jobId): BOOTING → deploy pod → HYDRATING → load checkpoint → READY
 * - run(agentId, jobId): READY → EXECUTING (start processing)
 * - pause(agentId): EXECUTING → write checkpoint → (job-level pause, pod stays alive)
 * - resume(agentId): resume from checkpoint → EXECUTING
 * - drain(agentId): EXECUTING → DRAINING → flush JSONL + checkpoint → TERMINATED
 * - crash(agentId, error): any → TERMINATED (log error, record crash)
 * - recover(agentId, jobId): CRASHED recovery → re-deploy → BOOTING
 * - terminate(agentId): any → DRAINING → TERMINATED (graceful shutdown)
 * - scaleToZero(agentId): triggered by idle detector
 */

import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import type { AgentDeployer } from "../k8s/agent-deployer.js"
import type { AgentDeploymentConfig } from "../k8s/types.js"
import { CrashLoopDetector, HeartbeatReceiver, type AgentHeartbeat } from "./health.js"
import { hydrateAgent, type HydrationResult, type QdrantClient } from "./hydration.js"
import { IdleDetector } from "./idle-detector.js"
import {
  AgentLifecycleStateMachine,
  type AgentLifecycleState,
  type LifecycleTransitionEvent,
} from "./state-machine.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LifecycleManagerDeps {
  db: Kysely<Database>
  deployer: AgentDeployer
  qdrantClient?: QdrantClient
  idleTimeoutMs?: number
  onLifecycleEvent?: (event: LifecycleTransitionEvent) => void
}

export interface AgentContext {
  agentId: string
  jobId: string
  stateMachine: AgentLifecycleStateMachine
  hydration: HydrationResult | null
  deploymentConfig: AgentDeploymentConfig | null
}

/** A steering message injected mid-execution. */
export interface SteerMessage {
  id: string
  agentId: string
  message: string
  priority: "normal" | "high"
  timestamp: Date
}

export type SteerListener = (msg: SteerMessage) => void

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class AgentLifecycleManager {
  private readonly db: Kysely<Database>
  private readonly deployer: AgentDeployer
  private readonly qdrantClient?: QdrantClient
  private readonly agents = new Map<string, AgentContext>()
  readonly heartbeatReceiver: HeartbeatReceiver
  readonly crashDetector: CrashLoopDetector
  readonly idleDetector: IdleDetector
  private readonly onLifecycleEvent?: (event: LifecycleTransitionEvent) => void
  /** agentId → listeners for steering messages */
  private readonly steerListeners = new Map<string, Set<SteerListener>>()

  constructor(deps: LifecycleManagerDeps) {
    this.db = deps.db
    this.deployer = deps.deployer
    this.qdrantClient = deps.qdrantClient
    this.onLifecycleEvent = deps.onLifecycleEvent

    this.heartbeatReceiver = new HeartbeatReceiver()
    this.crashDetector = new CrashLoopDetector()

    this.idleDetector = new IdleDetector({
      idleTimeoutMs: deps.idleTimeoutMs,
      onIdle: (agentId: string) => {
        void this.scaleToZero(agentId)
      },
    })
  }

  // -------------------------------------------------------------------------
  // boot: BOOTING → HYDRATING → READY
  // -------------------------------------------------------------------------

  /**
   * Boot an agent: create state machine, deploy pod, hydrate context.
   * Transitions: BOOTING → HYDRATING → READY
   */
  async boot(agentId: string, jobId: string): Promise<AgentContext> {
    // Check crash cooldown before boot
    if (this.crashDetector.isInCooldown(agentId)) {
      const record = this.crashDetector.getCrashRecord(agentId)!
      throw new Error(
        `Agent ${agentId} is in crash cooldown until ${record.cooldownUntil.toISOString()} ` +
          `(${record.crashCount} consecutive crashes)`,
      )
    }

    const sm = new AgentLifecycleStateMachine(agentId)
    if (this.onLifecycleEvent) {
      sm.onTransition(this.onLifecycleEvent)
    }

    const ctx: AgentContext = {
      agentId,
      jobId,
      stateMachine: sm,
      hydration: null,
      deploymentConfig: null,
    }
    this.agents.set(agentId, ctx)

    // BOOTING → HYDRATING
    sm.transition("HYDRATING", "Config loaded, starting hydration")

    try {
      // Hydrate: load checkpoint + identity in parallel, then Qdrant
      const hydration = await hydrateAgent({
        jobId,
        agentId,
        db: this.db,
        qdrantClient: this.qdrantClient,
      })
      ctx.hydration = hydration

      // HYDRATING → READY
      sm.transition("READY", "Hydration complete")

      // Start idle tracking
      this.idleDetector.recordActivity(agentId)

      return ctx
    } catch (error) {
      // Hydration failure → TERMINATED
      sm.transition("TERMINATED", `Hydration failed: ${String(error)}`)
      this.agents.delete(agentId)
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // run: READY → EXECUTING
  // -------------------------------------------------------------------------

  /**
   * Start executing a job. Transitions READY → EXECUTING.
   */
  run(agentId: string, jobId: string): void {
    const ctx = this.requireContext(agentId)
    ctx.stateMachine.transition("EXECUTING", `Starting job ${jobId}`)
    this.idleDetector.recordActivity(agentId)
  }

  // -------------------------------------------------------------------------
  // pause: EXECUTING → checkpoint (job-level, pod stays alive)
  // -------------------------------------------------------------------------

  /**
   * Pause an executing agent. Writes checkpoint, transitions job to
   * WAITING_FOR_APPROVAL. The pod stays alive and the lifecycle state
   * remains EXECUTING (pausing is a job-level concern, not pod-level).
   */
  async pause(agentId: string): Promise<void> {
    const ctx = this.requireContext(agentId)

    if (ctx.stateMachine.state !== "EXECUTING") {
      throw new Error(`Cannot pause agent ${agentId}: not in EXECUTING state`)
    }

    // Update job status to WAITING_FOR_APPROVAL
    await this.db
      .updateTable("job")
      .set({ status: "WAITING_FOR_APPROVAL", updated_at: new Date() })
      .where("id", "=", ctx.jobId)
      .execute()

    this.idleDetector.recordActivity(agentId)
  }

  // -------------------------------------------------------------------------
  // resume: continue from checkpoint → EXECUTING
  // -------------------------------------------------------------------------

  /**
   * Resume a paused agent. Transitions the job back to RUNNING.
   */
  async resume(agentId: string): Promise<void> {
    const ctx = this.requireContext(agentId)

    await this.db
      .updateTable("job")
      .set({ status: "RUNNING", updated_at: new Date() })
      .where("id", "=", ctx.jobId)
      .execute()

    this.idleDetector.recordActivity(agentId)
  }

  // -------------------------------------------------------------------------
  // drain: EXECUTING → DRAINING → TERMINATED
  // -------------------------------------------------------------------------

  /**
   * Graceful drain: stop processing, flush state, terminate.
   * Transitions: current state → DRAINING → TERMINATED
   */
  async drain(agentId: string, reason?: string): Promise<void> {
    const ctx = this.requireContext(agentId)
    const currentState = ctx.stateMachine.state

    // Only READY and EXECUTING can transition to DRAINING
    if (currentState !== "READY" && currentState !== "EXECUTING") {
      throw new Error(`Cannot drain agent ${agentId}: in ${currentState} state`)
    }

    ctx.stateMachine.transition("DRAINING", reason ?? "Graceful drain requested")

    try {
      // Delete the K8s pod (triggers SIGTERM → graceful shutdown inside the pod)
      await this.deployer.deleteAgent(agentId)
    } catch {
      // Pod deletion failure is non-fatal — the pod may already be gone
    }

    ctx.stateMachine.transition("TERMINATED", "Drain complete")
    this.cleanup(agentId)
  }

  // -------------------------------------------------------------------------
  // crash: any → TERMINATED (record crash, attempt recovery)
  // -------------------------------------------------------------------------

  /**
   * Record an agent crash. Transitions to TERMINATED, records crash
   * for CrashLoopBackOff detection.
   */
  crash(agentId: string, error: Error): void {
    const ctx = this.agents.get(agentId)
    if (ctx && ctx.stateMachine.state !== "TERMINATED") {
      ctx.stateMachine.transition("TERMINATED", `Crashed: ${error.message}`)
    }

    this.crashDetector.recordCrash(agentId)
    this.cleanup(agentId)
  }

  // -------------------------------------------------------------------------
  // recover: after crash → re-boot from checkpoint
  // -------------------------------------------------------------------------

  /**
   * Recover a crashed agent by re-booting from checkpoint.
   * Respects CrashLoopBackOff cooldown.
   */
  async recover(agentId: string, jobId: string): Promise<AgentContext> {
    // boot() already checks crash cooldown
    return this.boot(agentId, jobId)
  }

  // -------------------------------------------------------------------------
  // terminate: any → DRAINING → TERMINATED
  // -------------------------------------------------------------------------

  /**
   * Forcefully terminate an agent. Unlike drain, this can be called
   * from any state.
   */
  async terminate(agentId: string, reason?: string): Promise<void> {
    const ctx = this.agents.get(agentId)
    if (!ctx) return

    const state = ctx.stateMachine.state
    if (state === "TERMINATED") return

    // If in READY or EXECUTING, go through DRAINING first
    if (state === "READY" || state === "EXECUTING") {
      ctx.stateMachine.transition("DRAINING", reason ?? "Termination requested")
    }

    // States that can transition directly to TERMINATED: BOOTING, HYDRATING, DRAINING
    if (ctx.stateMachine.state !== "TERMINATED") {
      ctx.stateMachine.transition("TERMINATED", reason ?? "Terminated")
    }

    try {
      await this.deployer.deleteAgent(agentId)
    } catch {
      // Pod may already be gone
    }

    this.cleanup(agentId)
  }

  // -------------------------------------------------------------------------
  // scaleToZero: idle timeout → graceful terminate
  // -------------------------------------------------------------------------

  /**
   * Scale an agent to zero after idle timeout. Only acts on READY agents.
   */
  async scaleToZero(agentId: string): Promise<void> {
    const ctx = this.agents.get(agentId)
    if (!ctx) return

    // Only scale-to-zero agents that are READY (idle, not executing)
    if (ctx.stateMachine.state === "READY") {
      await this.drain(agentId, "Idle timeout — scale to zero")
    }
  }

  // -------------------------------------------------------------------------
  // Steering: mid-execution message injection
  // -------------------------------------------------------------------------

  /**
   * Inject a steering message to a running agent.
   * The agent must be in EXECUTING state.
   * Notifies all registered listeners for the agent.
   */
  steer(msg: SteerMessage): void {
    const ctx = this.requireContext(msg.agentId)

    if (ctx.stateMachine.state !== "EXECUTING") {
      throw new Error(
        `Cannot steer agent ${msg.agentId}: not in EXECUTING state (current: ${ctx.stateMachine.state})`,
      )
    }

    this.idleDetector.recordActivity(msg.agentId)

    const listeners = this.steerListeners.get(msg.agentId)
    if (listeners) {
      for (const listener of listeners) {
        listener(msg)
      }
    }
  }

  /**
   * Register a listener for steering messages to a specific agent.
   * Returns an unsubscribe function.
   */
  onSteer(agentId: string, listener: SteerListener): () => void {
    if (!this.steerListeners.has(agentId)) {
      this.steerListeners.set(agentId, new Set())
    }
    this.steerListeners.get(agentId)!.add(listener)

    return () => {
      this.steerListeners.get(agentId)?.delete(listener)
      if (this.steerListeners.get(agentId)?.size === 0) {
        this.steerListeners.delete(agentId)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat handling
  // -------------------------------------------------------------------------

  /**
   * Process an incoming heartbeat from an agent.
   */
  handleHeartbeat(heartbeat: AgentHeartbeat): void {
    this.heartbeatReceiver.recordHeartbeat(heartbeat)
    this.idleDetector.recordActivity(heartbeat.agentId)
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  getAgentState(agentId: string): AgentLifecycleState | undefined {
    return this.agents.get(agentId)?.stateMachine.state
  }

  getAgentContext(agentId: string): AgentContext | undefined {
    return this.agents.get(agentId)
  }

  get activeAgentCount(): number {
    return this.agents.size
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /**
   * Gracefully shut down the lifecycle manager.
   * Stops monitoring, clears timers, but does NOT terminate running agents.
   */
  shutdown(): void {
    this.heartbeatReceiver.stopMonitoring()
    this.idleDetector.shutdown()
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private requireContext(agentId: string): AgentContext {
    const ctx = this.agents.get(agentId)
    if (!ctx) {
      throw new Error(`Agent ${agentId} is not managed by this lifecycle manager`)
    }
    return ctx
  }

  private cleanup(agentId: string): void {
    this.agents.delete(agentId)
    this.idleDetector.removeAgent(agentId)
    this.heartbeatReceiver.removeAgent(agentId)
    this.steerListeners.delete(agentId)
  }
}
