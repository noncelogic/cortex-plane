/**
 * Browser Observation Routes
 *
 * Endpoints for live VNC streaming, screenshot capture,
 * trace recording, multi-tab queries, and annotation forwarding.
 *
 * GET    /agents/:agentId/observe/stream-status  — VNC availability + quality
 * GET    /agents/:agentId/observe/vnc            — WebSocket VNC proxy
 * POST   /agents/:agentId/observe/screenshot     — Capture screenshot (degraded mode)
 * GET    /agents/:agentId/observe/tabs           — List open browser tabs
 * GET    /agents/:agentId/observe/trace          — Get trace recording state
 * POST   /agents/:agentId/observe/trace/start    — Start trace recording
 * POST   /agents/:agentId/observe/trace/stop     — Stop trace recording + download
 * POST   /agents/:agentId/observe/annotate       — Forward annotation to agent
 *
 * All endpoints require per-session Bearer token authentication.
 */

import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

import type { AgentLifecycleManager } from "../lifecycle/manager.js"
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

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface ObservationRouteDeps {
  sseManager: SSEConnectionManager
  lifecycleManager: AgentLifecycleManager
  observationService: BrowserObservationService
}

export function observationRoutes(deps: ObservationRouteDeps) {
  const { sseManager, lifecycleManager, observationService } = deps

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
  }
}
