import { BackendRegistry } from "@cortex/shared/backends"
import type { ChannelAdapter, ChannelSupervisor } from "@cortex/shared/channels"
import fastifyCors from "@fastify/cors"
import fastifyWebSocket from "@fastify/websocket"
import Fastify, { type FastifyInstance } from "fastify"
import { makeWorkerUtils, type WorkerUtils } from "graphile-worker"
import type { Kysely } from "kysely"
import type pg from "pg"

import { ApprovalService } from "./approval/service.js"
import { CredentialService } from "./auth/credential-service.js"
import { SessionService } from "./auth/session-service.js"
import { ClaudeCodeBackend } from "./backends/claude-code.js"
import { HttpLlmBackend } from "./backends/http-llm.js"
import { AuthHandoffService } from "./browser/auth-handoff.js"
import { ScreenshotModeService } from "./browser/screenshot-mode.js"
import { TraceCaptureService } from "./browser/trace-capture.js"
import { AgentChannelService } from "./channels/agent-channel-service.js"
import type { Config } from "./config.js"
import type { Database } from "./db/types.js"
import { FeedbackService } from "./feedback/service.js"
import type { AgentLifecycleManager } from "./lifecycle/manager.js"
import { loadAuthConfig } from "./middleware/api-keys.js"
import { BrowserObservationService } from "./observation/service.js"
import { agentChannelRoutes } from "./routes/agent-channels.js"
import { agentRoutes } from "./routes/agents.js"
import { approvalRoutes } from "./routes/approval.js"
import { authRoutes } from "./routes/auth.js"
import { credentialRoutes } from "./routes/credentials.js"
import { dashboardRoutes } from "./routes/dashboard.js"
import { feedbackRoutes } from "./routes/feedback.js"
import { healthRoutes } from "./routes/health.js"
import { observationRoutes } from "./routes/observation.js"
import { streamRoutes } from "./routes/stream.js"
import { voiceRoutes } from "./routes/voice.js"
import { SSEConnectionManager } from "./streaming/manager.js"
import { createWorker, type Runner } from "./worker/index.js"
import { createMemoryScheduler } from "./worker/memory-scheduler.js"
import { registerShutdownHandlers } from "./worker/shutdown.js"

export interface AppContext {
  app: FastifyInstance
  runner: Runner
  sseManager: SSEConnectionManager
  observationService: BrowserObservationService
  registry: BackendRegistry
  channelSupervisor?: ChannelSupervisor
  enqueueJob: (jobId: string) => Promise<void>
}

export interface AppOptions {
  db: Kysely<Database>
  pool: pg.Pool
  config: Config
  lifecycleManager?: AgentLifecycleManager
  registry?: BackendRegistry
  channelSupervisor?: ChannelSupervisor
  voiceAdapters?: ReadonlyArray<ChannelAdapter>
}

export async function buildApp(options: AppOptions): Promise<AppContext> {
  const { db, pool, config } = options
  const app = Fastify({
    logger: {
      level: config.logLevel,
    },
  })

  // CORS support for dashboard origin
  await app.register(fastifyCors, {
    origin: process.env.DASHBOARD_ORIGIN ?? true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })

  // Initialize backend registry
  const registry = options.registry ?? (await createDefaultRegistry())

  // SSE connection manager for agent streaming
  const sseManager = new SSEConnectionManager()
  const channelSupervisor = options.channelSupervisor

  // Start Graphile Worker alongside Fastify — shared pg.Pool
  const runner = await createWorker({
    pgPool: pool,
    db,
    registry,
    streamManager: sseManager,
    memoryExtractThreshold: config.memoryExtractThreshold,
    concurrency: config.workerConcurrency,
  })

  // Worker utils for job enqueueing from routes
  const workerUtils: WorkerUtils = await makeWorkerUtils({ pgPool: pool })
  const memoryScheduler = createMemoryScheduler({
    db,
    threshold: config.memoryExtractThreshold,
  })

  // Browser observation service + orchestration services
  const observationService = new BrowserObservationService()
  const authHandoffService = new AuthHandoffService()
  const traceCaptureService = new TraceCaptureService()
  const screenshotModeService = new ScreenshotModeService(observationService)

  // WebSocket support (used by VNC proxy and future WS endpoints)
  await app.register(fastifyWebSocket)

  // Decorate Fastify with runner + db references for health checks
  app.decorate("worker", runner)
  app.decorate("db", db)
  app.decorate("sseManager", sseManager)
  if (channelSupervisor) {
    app.decorate("channelSupervisor", channelSupervisor)
  }

  // Approval service — core approval gate logic
  const approvalService = new ApprovalService({ db })
  const feedbackService = new FeedbackService({ db })

  // Load auth configuration for approval gate endpoints
  const authConfig = loadAuthConfig()

  // Session service + credential service (if OAuth is configured)
  let sessionService: SessionService | undefined
  let credentialService: CredentialService | undefined

  if (config.auth) {
    sessionService = new SessionService(db, config.auth.sessionMaxAge)
    credentialService = new CredentialService(db, config.auth)

    // Clean up expired sessions on startup
    sessionService.cleanupExpired().catch(() => {
      // Non-critical, log and continue
    })
  }

  // Decorate the Fastify instance with auth services for use in route plugins
  if (sessionService) {
    app.decorate("sessionService", sessionService)
  }

  await app.register(healthRoutes)

  let unsubscribeChannelSupervisor: (() => void) | undefined
  if (channelSupervisor) {
    channelSupervisor.start()
    unsubscribeChannelSupervisor = channelSupervisor.subscribe((statuses) => {
      sseManager.broadcast("_channel_health", "channel:health", {
        timestamp: new Date().toISOString(),
        adapters: statuses,
      })
    })
  }

  // Register approval routes (always available)
  await app.register(approvalRoutes({ approvalService, sseManager, authConfig, sessionService }))
  await app.register(feedbackRoutes({ feedbackService }))

  // Register agent CRUD + job routes
  await app.register(
    agentRoutes({
      db,
      authConfig,
      sessionService,
      enqueueJob: async (jobId: string) => {
        await workerUtils.addJob("agent_execute", { jobId }, { jobKey: `exec:${jobId}` })
      },
    }),
  )

  // Register agent channel binding routes
  const agentChannelService = new AgentChannelService(db)
  await app.register(
    agentChannelRoutes({
      service: agentChannelService,
      authConfig,
      sessionService,
    }),
  )

  // Register dashboard compatibility endpoints that map to existing services/tables.
  await app.register(
    dashboardRoutes({
      db,
      enqueueJob: async (jobId: string) => {
        await workerUtils.addJob("agent_execute", { jobId }, { jobKey: `exec:${jobId}` })
      },
      observationService,
    }),
  )

  // Register auth + credential management routes (if OAuth configured)
  if (config.auth && sessionService && credentialService) {
    await app.register(
      authRoutes({ db, authConfig: config.auth, sessionService, credentialService }),
    )
    await app.register(credentialRoutes({ credentialService, sessionService }))
  }

  // Always register streaming + observation routes
  // (lifecycleManager is optional — routes handle its absence gracefully)
  await app.register(
    streamRoutes({ sseManager, lifecycleManager: options.lifecycleManager, sessionService }),
  )
  await app.register(
    voiceRoutes({
      db,
      adapters: options.voiceAdapters,
    }),
  )
  await app.register(
    observationRoutes({
      sseManager,
      lifecycleManager: options.lifecycleManager,
      observationService,
      authHandoffService,
      traceCaptureService,
      screenshotModeService,
      authConfig,
      sessionService,
    }),
  )

  // Recovery flush: enqueue extraction jobs for any pending session messages.
  await memoryScheduler.flushAllPending(workerUtils).catch((err: unknown) => {
    app.log.error({ err }, "Failed to enqueue pending memory extraction jobs on startup")
  })

  // Register graceful shutdown handlers (SIGTERM, SIGINT)
  registerShutdownHandlers({
    fastify: app,
    runner,
    pool,
    onDrainStart: async () => {
      await memoryScheduler.flushAllPending(workerUtils)
    },
  })

  // Shut down SSE connections + observation service + browser services + backend registry on app close
  app.addHook("onClose", async () => {
    if (unsubscribeChannelSupervisor) {
      unsubscribeChannelSupervisor()
    }
    channelSupervisor?.stop()
    sseManager.shutdown()
    screenshotModeService.shutdown()
    authHandoffService.shutdown()
    traceCaptureService.shutdown()
    await observationService.shutdown()
    await workerUtils.release()
    await registry.stopAll()
  })

  const enqueueJob = async (jobId: string) => {
    await workerUtils.addJob("agent_execute", { jobId }, { jobKey: `exec:${jobId}` })
  }

  return { app, runner, sseManager, observationService, registry, channelSupervisor, enqueueJob }
}

/**
 * Create a default BackendRegistry with the Claude Code and HTTP LLM backends.
 * Backends start in a degraded state if configuration is unavailable.
 */
async function createDefaultRegistry(): Promise<BackendRegistry> {
  const registry = new BackendRegistry()

  // Claude Code backend (CLI-based)
  const claudeBackend = new ClaudeCodeBackend()
  try {
    await registry.register(
      claudeBackend,
      { binaryPath: process.env.CLAUDE_BINARY_PATH ?? "claude" },
      parseInt(process.env.BACKEND_MAX_CONCURRENT ?? "3", 10),
    )
  } catch {
    // Backend registration failed (e.g. binary not found).
    // The registry remains empty — jobs will fail with a clear error.
  }

  // HTTP LLM backend (API-based)
  const llmBackend = new HttpLlmBackend()
  try {
    await registry.register(
      llmBackend,
      {
        provider: process.env.LLM_PROVIDER ?? "anthropic",
        apiKey: process.env.LLM_API_KEY,
        model: process.env.LLM_MODEL,
        baseUrl: process.env.LLM_BASE_URL,
      },
      parseInt(process.env.LLM_MAX_CONCURRENT ?? "5", 10),
    )
  } catch {
    // LLM backend registration failed (e.g. no API key).
  }

  return registry
}
