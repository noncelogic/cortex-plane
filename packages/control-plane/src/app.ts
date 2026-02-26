import Fastify, { type FastifyInstance } from "fastify"
import fastifyWebSocket from "@fastify/websocket"
import type { Kysely } from "kysely"
import type pg from "pg"

import { BackendRegistry } from "@cortex/shared/backends"
import { ApprovalService } from "./approval/service.js"
import { ClaudeCodeBackend } from "./backends/claude-code.js"
import { AuthHandoffService } from "./browser/auth-handoff.js"
import { ScreenshotModeService } from "./browser/screenshot-mode.js"
import { TraceCaptureService } from "./browser/trace-capture.js"
import type { Config } from "./config.js"
import type { Database } from "./db/types.js"
import type { AgentLifecycleManager } from "./lifecycle/manager.js"
import { loadAuthConfig } from "./middleware/api-keys.js"
import { BrowserObservationService } from "./observation/service.js"
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

  // Register streaming + observation routes if lifecycle manager is provided
  if (options.lifecycleManager) {
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
  }

  // Register graceful shutdown handlers (SIGTERM, SIGINT)
  registerShutdownHandlers({ fastify: app, runner, pool })

  // Shut down SSE connections + observation service + browser services + backend registry on app close
  app.addHook("onClose", async () => {
    sseManager.shutdown()
    screenshotModeService.shutdown()
    authHandoffService.shutdown()
    traceCaptureService.shutdown()
    await observationService.shutdown()
    await registry.stopAll()
  })

  return { app, runner, sseManager, observationService, registry }
}

/**
 * Create a default BackendRegistry with the Claude Code backend.
 * The backend starts in a degraded state if the `claude` binary is unavailable.
 */
async function createDefaultRegistry(): Promise<BackendRegistry> {
  const registry = new BackendRegistry()

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

  return registry
}
