/**
 * Browser Observation Routes
 *
 * Endpoints for live VNC streaming, screenshot capture,
 * trace recording, multi-tab queries, annotation forwarding,
 * annotation steering, auth handoff, and screenshot streaming.
 *
 * --- Existing observe endpoints ---
 * GET    /agents/:agentId/observe/stream-status   — VNC availability + quality
 * GET    /agents/:agentId/observe/vnc             — WebSocket VNC proxy
 * POST   /agents/:agentId/observe/screenshot      — Capture screenshot (degraded mode)
 * GET    /agents/:agentId/observe/tabs            — List open browser tabs
 * GET    /agents/:agentId/observe/trace           — Get trace recording state
 * POST   /agents/:agentId/observe/trace/start     — Start trace recording
 * POST   /agents/:agentId/observe/trace/stop      — Stop trace recording + download
 * POST   /agents/:agentId/observe/annotate        — Forward annotation to agent
 *
 * --- New browser orchestration endpoints ---
 * POST   /agents/:agentId/browser/steer              — Annotation steering
 * POST   /agents/:agentId/browser/auth-handoff        — Inject auth into browser
 * GET    /agents/:agentId/browser/trace               — List trace metadata
 * POST   /agents/:agentId/browser/trace/start         — Start trace + register metadata
 * POST   /agents/:agentId/browser/trace/stop          — Stop trace + register metadata
 * GET    /agents/:agentId/browser/screenshot/stream    — SSE screenshot stream
 *
 * All endpoints require per-session Bearer token authentication.
 * Auth handoff additionally requires the "approver" role via API key auth.
 */

import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

import type { AnnotationPayload } from "@cortex/shared/browser"
import type { AuthHandoffService } from "../browser/auth-handoff.js"
import type { ScreenshotModeService } from "../browser/screenshot-mode.js"
import { annotationToAction, annotationToPrompt } from "../browser/steering.js"
import type { TraceCaptureService } from "../browser/trace-capture.js"
import type { AgentLifecycleManager } from "../lifecycle/manager.js"
import { createRequireAuth, createRequireRole } from "../middleware/auth.js"
import type { AuthConfig, AuthenticatedRequest as PrincipalRequest } from "../middleware/types.js"
import type { BrowserObservationService } from "../observation/service.js"
import type { AnnotationEvent, ScreenshotRequest, TraceRecordingOptions } from "../observation/types.js"
import {
  SSEConnectionManager,
  createStreamAuth,
  type AuthenticatedRequest,
} from "../streaming/index.js"

// ---------------------------------------------------------------------------
// Route parameter / body types
// ---------------------------------------------------------------------------

interface AgentParams {
  agentId: string
}

interface AuthHandoffBody {
  targetUrl: string
  cookies?: Array<{
    name: string; value: string; domain: string
    path?: string; secure?: boolean; httpOnly?: boolean
    sameSite?: "Strict" | "Lax" | "None"; expires?: number
  }>
  localStorage?: Record<string, string>
  sessionToken?: string
}

interface ScreenshotStreamBody {
  intervalMs?: number
  format?: "jpeg" | "png"
  quality?: number
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface ObservationRouteDeps {
  sseManager: SSEConnectionManager
  lifecycleManager: AgentLifecycleManager
  observationService: BrowserObservationService
  authHandoffService?: AuthHandoffService
  traceCaptureService?: TraceCaptureService
  screenshotModeService?: ScreenshotModeService
  authConfig?: AuthConfig
}

export function observationRoutes(deps: ObservationRouteDeps) {
  const {
    sseManager,
    lifecycleManager,
    observationService,
    authHandoffService,
    traceCaptureService,
    screenshotModeService,
    authConfig,
  } = deps

  return function register(app: FastifyInstance): void {
    const authHook = createStreamAuth(app.db)

    // Helper: verify agent exists and is alive
    function getAgentOrFail(
      agentId: string,
      reply: FastifyReply,
    ): boolean {
      const state = lifecycleManager.getAgentState(agentId)
      if (!state) {
        reply.status(404).send({
          error: "not_found",
          message: `Agent ${agentId} is not managed by this control plane`,
        })
        return false
      }
      if (state === "TERMINATED") {
        reply.status(410).send({
          error: "gone",
          message: `Agent ${agentId} has terminated`,
        })
        return false
      }
      return true
    }

    // -----------------------------------------------------------------
    // GET /agents/:agentId/observe/stream-status
    // -----------------------------------------------------------------

    app.get<{ Params: AgentParams }>(
      "/agents/:agentId/observe/stream-status",
      {
        preHandler: authHook,
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
        const { agentId } = request.params
        if (!getAgentOrFail(agentId, reply)) return

        const status = await observationService.getStreamStatus(agentId)
        return reply.send(status)
      },
    )

    // -----------------------------------------------------------------
    // GET /agents/:agentId/observe/vnc — WebSocket VNC proxy
    // -----------------------------------------------------------------

    app.get<{ Params: AgentParams }>(
      "/agents/:agentId/observe/vnc",
      {
        preHandler: authHook,
        websocket: true,
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
        },
      },
      async (socket, request) => {
        const { agentId } = request.params
        const state = lifecycleManager.getAgentState(agentId)

        if (!state || state === "TERMINATED") {
          socket.close(1008, "Agent not available")
          return
        }

        request.log.info({ agentId }, "VNC WebSocket proxy established")

        // Proxy to sidecar websockify
        observationService.proxyVncWebSocket(socket)

        socket.on("close", () => {
          request.log.info({ agentId }, "VNC WebSocket proxy closed")
        })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/observe/screenshot
    // -----------------------------------------------------------------

    app.post<{ Params: AgentParams; Body: ScreenshotRequest }>(
      "/agents/:agentId/observe/screenshot",
      {
        preHandler: authHook,
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              format: { type: "string", enum: ["jpeg", "png"] },
              quality: { type: "integer", minimum: 1, maximum: 100 },
              fullPage: { type: "boolean" },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams; Body: ScreenshotRequest }>, reply: FastifyReply) => {
        const { agentId } = request.params
        if (!getAgentOrFail(agentId, reply)) return

        try {
          const result = await observationService.captureScreenshot(agentId, request.body ?? {})

          // Also broadcast via SSE for any connected dashboard clients
          sseManager.broadcast(agentId, "browser:screenshot", {
            agentId,
            timestamp: result.timestamp,
            url: result.url,
            title: result.title,
          })

          return reply.send(result)
        } catch (err) {
          request.log.error(err, "Screenshot capture failed")
          return reply.status(502).send({
            error: "upstream_error",
            message: err instanceof Error ? err.message : "Screenshot capture failed",
          })
        }
      },
    )

    // -----------------------------------------------------------------
    // GET /agents/:agentId/observe/tabs
    // -----------------------------------------------------------------

    app.get<{ Params: AgentParams }>(
      "/agents/:agentId/observe/tabs",
      {
        preHandler: authHook,
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
        const { agentId } = request.params
        if (!getAgentOrFail(agentId, reply)) return

        try {
          const tabs = await observationService.listTabs(agentId)
          return reply.send(tabs)
        } catch (err) {
          request.log.error(err, "Tab listing failed")
          return reply.status(502).send({
            error: "upstream_error",
            message: err instanceof Error ? err.message : "Failed to list tabs",
          })
        }
      },
    )

    // -----------------------------------------------------------------
    // GET /agents/:agentId/observe/trace — current trace state
    // -----------------------------------------------------------------

    app.get<{ Params: AgentParams }>(
      "/agents/:agentId/observe/trace",
      {
        preHandler: authHook,
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
        const { agentId } = request.params
        if (!getAgentOrFail(agentId, reply)) return

        const state = observationService.getTraceState(agentId)
        return reply.send(state)
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/observe/trace/start
    // -----------------------------------------------------------------

    app.post<{ Params: AgentParams; Body: TraceRecordingOptions }>(
      "/agents/:agentId/observe/trace/start",
      {
        preHandler: authHook,
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              snapshots: { type: "boolean" },
              screenshots: { type: "boolean" },
              network: { type: "boolean" },
              console: { type: "boolean" },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams; Body: TraceRecordingOptions }>, reply: FastifyReply) => {
        const { agentId } = request.params
        if (!getAgentOrFail(agentId, reply)) return

        try {
          const state = await observationService.startTrace(agentId, request.body ?? {})

          sseManager.broadcast(agentId, "browser:trace:state", {
            agentId,
            status: state.status,
            startedAt: state.startedAt,
            timestamp: new Date().toISOString(),
          })

          return reply.status(202).send(state)
        } catch (err) {
          request.log.error(err, "Trace start failed")
          const message = err instanceof Error ? err.message : "Failed to start trace"
          const status = message.includes("already in progress") ? 409 : 502
          return reply.status(status).send({
            error: status === 409 ? "conflict" : "upstream_error",
            message,
          })
        }
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/observe/trace/stop
    // -----------------------------------------------------------------

    app.post<{ Params: AgentParams }>(
      "/agents/:agentId/observe/trace/stop",
      {
        preHandler: authHook,
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
        const { agentId } = request.params
        if (!getAgentOrFail(agentId, reply)) return

        try {
          const result = await observationService.stopTrace(agentId)

          sseManager.broadcast(agentId, "browser:trace:state", {
            agentId,
            status: "idle",
            timestamp: new Date().toISOString(),
          })

          return reply.send(result)
        } catch (err) {
          request.log.error(err, "Trace stop failed")
          const message = err instanceof Error ? err.message : "Failed to stop trace"
          const status = message.includes("No active trace") ? 409 : 502
          return reply.status(status).send({
            error: status === 409 ? "conflict" : "upstream_error",
            message,
          })
        }
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/observe/annotate
    // -----------------------------------------------------------------

    app.post<{ Params: AgentParams; Body: AnnotationEvent }>(
      "/agents/:agentId/observe/annotate",
      {
        preHandler: authHook,
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["click", "hover", "scroll", "highlight"] },
              x: { type: "number" },
              y: { type: "number" },
              selector: { type: "string" },
              prompt: { type: "string", maxLength: 10_000 },
              scrollDelta: { type: "number" },
            },
            required: ["type", "x", "y"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams; Body: AnnotationEvent }>, reply: FastifyReply) => {
        const { agentId } = request.params
        if (!getAgentOrFail(agentId, reply)) return

        const agentState = lifecycleManager.getAgentState(agentId)
        if (agentState !== "EXECUTING") {
          return reply.status(409).send({
            error: "conflict",
            message: `Cannot forward annotation: agent is in ${agentState} state, must be EXECUTING`,
          })
        }

        const event = request.body

        // Generate a coordinate-based prompt for the agent
        const prompt = event.prompt
          ?? `User clicked at coordinates (${event.x}, ${event.y})${event.selector ? ` on element "${event.selector}"` : ""}. Investigate this element.`

        // Forward annotation to the observation service
        const result = await observationService.forwardAnnotation(agentId, event)

        // Inject as a steering message via lifecycle manager
        const steerMessageId = randomUUID()
        try {
          lifecycleManager.steer({
            id: steerMessageId,
            agentId,
            message: `[ANNOTATION] ${prompt}`,
            priority: "normal",
            timestamp: new Date(),
          })
        } catch {
          // Agent state may have changed
        }

        // Broadcast annotation acknowledgment via SSE
        sseManager.broadcast(agentId, "browser:annotation:ack", {
          agentId,
          annotationId: result.annotationId,
          event,
          prompt,
          timestamp: result.timestamp,
        })

        return reply.status(202).send(result)
      },
    )

    // =================================================================
    // New Browser Orchestration Endpoints
    // =================================================================

    // -----------------------------------------------------------------
    // POST /agents/:agentId/browser/steer — Annotation Steering
    // -----------------------------------------------------------------

    app.post<{ Params: AgentParams; Body: AnnotationPayload }>(
      "/agents/:agentId/browser/steer",
      {
        preHandler: authHook,
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["click", "type", "scroll", "highlight", "select"] },
              coordinates: {
                type: "object",
                properties: {
                  x: { type: "number" },
                  y: { type: "number" },
                },
                required: ["x", "y"],
              },
              selector: { type: "string" },
              text: { type: "string", maxLength: 10_000 },
              metadata: { type: "object" },
            },
            required: ["type", "coordinates"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams; Body: AnnotationPayload }>, reply: FastifyReply) => {
        const { agentId } = request.params
        if (!getAgentOrFail(agentId, reply)) return

        const agentState = lifecycleManager.getAgentState(agentId)
        if (agentState !== "EXECUTING") {
          return reply.status(409).send({
            error: "conflict",
            message: `Cannot steer: agent is in ${agentState} state, must be EXECUTING`,
          })
        }

        const annotation: AnnotationPayload = {
          ...request.body,
          metadata: request.body.metadata ?? {},
        }

        // Convert annotation to structured action
        const action = annotationToAction(annotation)
        const prompt = annotationToPrompt(annotation)

        // Inject as a steering message
        const steerMessageId = randomUUID()
        try {
          lifecycleManager.steer({
            id: steerMessageId,
            agentId,
            message: `[STEER] ${prompt}`,
            priority: "normal",
            timestamp: new Date(),
          })
        } catch {
          // Agent state may have changed
        }

        // Broadcast the steer action via SSE
        sseManager.broadcast(agentId, "browser:steer:action", {
          agentId,
          steerMessageId,
          action,
          prompt,
          timestamp: new Date().toISOString(),
        })

        return reply.status(202).send({
          agentId,
          steerMessageId,
          action,
          prompt,
          timestamp: new Date().toISOString(),
        })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/browser/auth-handoff
    // -----------------------------------------------------------------

    if (authHandoffService && authConfig) {
      const requireAuth = createRequireAuth(authConfig)
      const requireApprover = createRequireRole("approver")

      app.post<{ Params: AgentParams; Body: AuthHandoffBody }>(
        "/agents/:agentId/browser/auth-handoff",
        {
          preHandler: [requireAuth, requireApprover],
          schema: {
            params: {
              type: "object",
              properties: { agentId: { type: "string" } },
              required: ["agentId"],
            },
            body: {
              type: "object",
              properties: {
                targetUrl: { type: "string", format: "uri" },
                cookies: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      value: { type: "string" },
                      domain: { type: "string" },
                      path: { type: "string" },
                      secure: { type: "boolean" },
                      httpOnly: { type: "boolean" },
                      sameSite: { type: "string", enum: ["Strict", "Lax", "None"] },
                      expires: { type: "number" },
                    },
                    required: ["name", "value", "domain"],
                  },
                },
                localStorage: { type: "object" },
                sessionToken: { type: "string" },
              },
              required: ["targetUrl"],
            },
          },
        },
        async (request: FastifyRequest<{ Params: AgentParams; Body: AuthHandoffBody }>, reply: FastifyReply) => {
          const { agentId } = request.params
          if (!getAgentOrFail(agentId, reply)) return

          const principal = (request as PrincipalRequest).principal

          try {
            const result = await authHandoffService.prepareHandoff(
              { agentId, ...request.body },
              principal.userId,
              principal.displayName,
            )

            sseManager.broadcast(agentId, "browser:auth:handoff", {
              agentId,
              targetUrl: request.body.targetUrl,
              success: result.success,
              timestamp: result.injectedAt,
            })

            return reply.status(202).send(result)
          } catch (err) {
            request.log.error(err, "Auth handoff failed")
            return reply.status(502).send({
              error: "upstream_error",
              message: err instanceof Error ? err.message : "Auth handoff failed",
            })
          }
        },
      )
    }

    // -----------------------------------------------------------------
    // GET /agents/:agentId/browser/trace — List trace metadata
    // -----------------------------------------------------------------

    if (traceCaptureService) {
      app.get<{ Params: AgentParams }>(
        "/agents/:agentId/browser/trace",
        {
          preHandler: authHook,
          schema: {
            params: {
              type: "object",
              properties: { agentId: { type: "string" } },
              required: ["agentId"],
            },
          },
        },
        async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
          const { agentId } = request.params
          if (!getAgentOrFail(agentId, reply)) return

          const traces = traceCaptureService.getTraces(agentId)
          return reply.send({ agentId, traces })
        },
      )

      // -----------------------------------------------------------------
      // POST /agents/:agentId/browser/trace/start
      // -----------------------------------------------------------------

      app.post<{ Params: AgentParams; Body: TraceRecordingOptions & { jobId?: string } }>(
        "/agents/:agentId/browser/trace/start",
        {
          preHandler: authHook,
          schema: {
            params: {
              type: "object",
              properties: { agentId: { type: "string" } },
              required: ["agentId"],
            },
            body: {
              type: "object",
              properties: {
                jobId: { type: "string" },
                snapshots: { type: "boolean" },
                screenshots: { type: "boolean" },
                network: { type: "boolean" },
                console: { type: "boolean" },
              },
            },
          },
        },
        async (request: FastifyRequest<{ Params: AgentParams; Body: TraceRecordingOptions & { jobId?: string } }>, reply: FastifyReply) => {
          const { agentId } = request.params
          if (!getAgentOrFail(agentId, reply)) return

          try {
            const { jobId, ...traceOpts } = request.body ?? {}
            const state = await observationService.startTrace(agentId, traceOpts)

            sseManager.broadcast(agentId, "browser:trace:state", {
              agentId,
              status: state.status,
              startedAt: state.startedAt,
              timestamp: new Date().toISOString(),
            })

            return reply.status(202).send({ ...state, jobId })
          } catch (err) {
            request.log.error(err, "Trace start failed")
            const message = err instanceof Error ? err.message : "Failed to start trace"
            const status = message.includes("already in progress") ? 409 : 502
            return reply.status(status).send({
              error: status === 409 ? "conflict" : "upstream_error",
              message,
            })
          }
        },
      )

      // -----------------------------------------------------------------
      // POST /agents/:agentId/browser/trace/stop
      // -----------------------------------------------------------------

      app.post<{ Params: AgentParams; Body: { jobId?: string } }>(
        "/agents/:agentId/browser/trace/stop",
        {
          preHandler: authHook,
          schema: {
            params: {
              type: "object",
              properties: { agentId: { type: "string" } },
              required: ["agentId"],
            },
            body: {
              type: "object",
              properties: {
                jobId: { type: "string" },
              },
            },
          },
        },
        async (request: FastifyRequest<{ Params: AgentParams; Body: { jobId?: string } }>, reply: FastifyReply) => {
          const { agentId } = request.params
          if (!getAgentOrFail(agentId, reply)) return

          try {
            const traceState = observationService.getTraceState(agentId)
            const startedAt = traceState.startedAt ?? new Date().toISOString()

            const result = await observationService.stopTrace(agentId)
            const stoppedAt = new Date().toISOString()

            // Register trace metadata
            const jobId = request.body?.jobId ?? "unknown"
            const metadata = await traceCaptureService.registerTrace(
              agentId,
              jobId,
              result.filePath,
              startedAt,
              stoppedAt,
            )

            sseManager.broadcast(agentId, "browser:trace:state", {
              agentId,
              status: "idle",
              metadata,
              timestamp: stoppedAt,
            })

            return reply.send({ ...result, metadata })
          } catch (err) {
            request.log.error(err, "Trace stop failed")
            const message = err instanceof Error ? err.message : "Failed to stop trace"
            const status = message.includes("No active trace") ? 409 : 502
            return reply.status(status).send({
              error: status === 409 ? "conflict" : "upstream_error",
              message,
            })
          }
        },
      )
    }

    // -----------------------------------------------------------------
    // GET /agents/:agentId/browser/screenshot/stream — SSE screenshot stream
    // -----------------------------------------------------------------

    if (screenshotModeService) {
      app.get<{ Params: AgentParams; Querystring: ScreenshotStreamBody }>(
        "/agents/:agentId/browser/screenshot/stream",
        {
          preHandler: authHook,
          schema: {
            params: {
              type: "object",
              properties: { agentId: { type: "string" } },
              required: ["agentId"],
            },
            querystring: {
              type: "object",
              properties: {
                intervalMs: { type: "integer", minimum: 500, maximum: 30_000 },
                format: { type: "string", enum: ["jpeg", "png"] },
                quality: { type: "integer", minimum: 1, maximum: 100 },
              },
            },
          },
        },
        async (request: FastifyRequest<{ Params: AgentParams; Querystring: ScreenshotStreamBody }>, reply: FastifyReply) => {
          const { agentId } = request.params
          if (!getAgentOrFail(agentId, reply)) return

          const config = screenshotModeService.start(agentId, request.query)

          // Set up SSE response
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          })

          // Register a frame listener that writes to this SSE connection
          const unsubscribe = screenshotModeService.onFrame(agentId, (frame) => {
            if (frame.changed) {
              const event = `event: browser:screenshot:frame\ndata: ${JSON.stringify(frame)}\n\n`
              reply.raw.write(event)

              // Also broadcast to SSE manager for dashboard clients
              sseManager.broadcast(agentId, "browser:screenshot:frame", frame)
            }
          })

          // Send initial config
          reply.raw.write(`event: config\ndata: ${JSON.stringify(config)}\n\n`)

          // Cleanup on disconnect
          request.raw.on("close", () => {
            unsubscribe()
          })
        },
      )
    }
  }
}
