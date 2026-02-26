import Fastify, { type FastifyInstance } from "fastify"
import fastifyCors from "@fastify/cors"
import fastifyWebSocket from "@fastify/websocket"
import type { Kysely } from "kysely"
import type pg from "pg"
import { makeWorkerUtils, type WorkerUtils } from "graphile-worker"

import { BackendRegistry } from "@cortex/shared/backends"
import { ApprovalService } from "./approval/service.js"
import { ClaudeCodeBackend } from "./backends/claude-code.js"
import { HttpLlmBackend } from "./backends/http-llm.js"
import { AuthHandoffService } from "./browser/auth-handoff.js"
import { ScreenshotModeService } from "./browser/screenshot-mode.js"
import { TraceCaptureService } from "./browser/trace-capture.js"
import type { Config } from "./config.js"
import type { Database } from "./db/types.js"
import type { AgentLifecycleManager } from "./lifecycle/manager.js"
import { loadAuthConfig } from "./middleware/api-keys.js"
import { BrowserObservationService } from "./observation/service.js"
import { agentRoutes } from "./routes/agents.js"
import { approvalRoutes } from "./routes/approval.js"
import { healthRoutes } from "./routes/health.js"
import { observationRoutes } from "./routes/observation.js"
import { streamRoutes } from "./routes/stream.js"
import { SSEConnectionManager } from "./streaming/manager.js"
import { createWorker, type Runner } from "./worker/index.js"
import { registerShutdownHandlers } from "./worker/shutdown.js"

export interface AppContext {
  app: FastifyInstance
  runner: Runner
  sseManager: SSEConnectionManager
  observationService: BrowserObservationService
  registry: BackendRegistry
}

export interface AppOptions {
  db: Kysely<Database>
  pool: pg.Pool
  config: Config
  lifecycleManager?: AgentLifecycleManager
  registry?: BackendRegistry
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
  const registry = options.registry ?? await createDefaultRegistry()

  // SSE connection manager for agent streaming
  const sseManager = new SSEConnectionManager()

  // Start Graphile Worker alongside Fastify — shared pg.Pool
  const runner = await createWorker({
    pgPool: pool,
    db,
    registry,
    streamManager: sseManager,
    concurrency: config.workerConcurrency,
  })

  // Worker utils for job enqueueing from routes
  const workerUtils: WorkerUtils = await makeWorkerUtils({ pgPool: pool })

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

  // Approval service — core approval gate logic
  const approvalService = new ApprovalService({ db })

  // Load auth configuration for approval gate endpoints
  const authConfig = loadAuthConfig()

  await app.register(healthRoutes)

  // Register approval routes (always available)
  await app.register(
    approvalRoutes({ approvalService, sseManager, authConfig }),
  )

  // Register agent CRUD + job routes
  await app.register(
    agentRoutes({
      db,
      authConfig,
      enqueueJob: async (jobId: string) => {
        await workerUtils.addJob("agent_execute", { jobId }, { jobKey: `exec:${jobId}` })
      },
    }),
  )

  // Always register streaming + observation routes
  // (lifecycleManager is optional — routes handle its absence gracefully)
  await app.register(
    streamRoutes({ sseManager, lifecycleManager: options.lifecycleManager }),
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
    }),
  )

  // Register graceful shutdown handlers (SIGTERM, SIGINT)
  registerShutdownHandlers({ fastify: app, runner, pool })

  // Shut down SSE connections + observation service + browser services + backend registry on app close
  app.addHook("onClose", async () => {
    sseManager.shutdown()
    screenshotModeService.shutdown()
    authHandoffService.shutdown()
    traceCaptureService.shutdown()
    await observationService.shutdown()
    await workerUtils.release()
    await registry.stopAll()
  })

  return { app, runner, sseManager, observationService, registry }
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
