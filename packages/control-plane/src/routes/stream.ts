/**
 * SSE Streaming Routes
 *
 * GET  /agents/:agentId/stream — SSE endpoint for live agent output
 * POST /agents/:agentId/steer  — inject mid-execution steering message
 *
 * Both endpoints require per-session Bearer token authentication.
 * The SSE endpoint supports reconnection via Last-Event-ID header.
 */

import { randomUUID } from "node:crypto"

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import type { SessionService } from "../auth/session-service.js"
import type { AgentLifecycleManager } from "../lifecycle/manager.js"
import {
  type AuthenticatedRequest,
  createStreamAuth,
  SSEConnectionManager,
} from "../streaming/index.js"

// ---------------------------------------------------------------------------
// Route options types
// ---------------------------------------------------------------------------

interface StreamParams {
  agentId: string
}

interface SteerBody {
  message: string
  priority?: "normal" | "high"
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface StreamRouteDeps {
  sseManager: SSEConnectionManager
  lifecycleManager?: AgentLifecycleManager
  sessionService?: SessionService
}

export function streamRoutes(deps: StreamRouteDeps) {
  const { sseManager, lifecycleManager, sessionService } = deps

  return function register(app: FastifyInstance): void {
    const authHook = createStreamAuth({ db: app.db, sessionService })

    // -----------------------------------------------------------------
    // GET /agents/:agentId/stream — SSE live output
    // -----------------------------------------------------------------

    app.get<{ Params: StreamParams }>(
      "/agents/:agentId/stream",
      {
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Fastify awaits async preHandlers
        preHandler: authHook,
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
            },
            required: ["agentId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: StreamParams }>, reply: FastifyReply) => {
        const { agentId } = request.params

        // Verify agent is alive (if lifecycle manager is available)
        const agentState = lifecycleManager?.getAgentState(agentId)
        if (lifecycleManager && !agentState) {
          return reply.status(404).send({
            error: "not_found",
            message: `Agent ${agentId} is not managed by this control plane`,
          })
        }

        if (agentState === "TERMINATED") {
          return reply.status(410).send({
            error: "gone",
            message: `Agent ${agentId} has terminated`,
          })
        }

        // Support reconnection via Last-Event-ID
        const lastEventId = (request.headers["last-event-id"] as string | undefined) ?? null

        // Hijack the response for raw SSE streaming
        // We must prevent Fastify from sending its own response
        const raw = reply.raw

        const conn = sseManager.connect(agentId, raw, lastEventId)

        request.log.info(
          { agentId, connectionId: conn.connectionId, lastEventId },
          "SSE connection established",
        )

        // Send initial state event
        sseManager.broadcast(agentId, "agent:state", {
          agentId,
          timestamp: new Date().toISOString(),
          state: agentState ?? "UNKNOWN",
        })

        // Don't let Fastify try to send a response — we've taken over
        // reply.hijack() tells Fastify we're handling the response ourselves
        reply.hijack()
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/steer — mid-execution steering
    // -----------------------------------------------------------------

    app.post<{ Params: StreamParams; Body: SteerBody }>(
      "/agents/:agentId/steer",
      {
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Fastify awaits async preHandlers
        preHandler: authHook,
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
            },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              message: { type: "string", minLength: 1, maxLength: 10_000 },
              priority: { type: "string", enum: ["normal", "high"] },
            },
            required: ["message"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: StreamParams; Body: SteerBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { message, priority } = request.body
        const authContext = (request as AuthenticatedRequest).authContext

        const steerMessageId = randomUUID()
        const steerPriority = priority ?? "normal"

        request.log.info(
          { agentId, steerMessageId, priority: steerPriority, sessionId: authContext.sessionId },
          "Steering message received",
        )

        // Route the steering message through the lifecycle manager (if available)
        if (lifecycleManager) {
          const agentState = lifecycleManager.getAgentState(agentId)
          if (!agentState) {
            return reply.status(404).send({
              error: "not_found",
              message: `Agent ${agentId} is not managed by this control plane`,
            })
          }

          if (agentState !== "EXECUTING") {
            return reply.status(409).send({
              error: "conflict",
              message: `Cannot steer agent ${agentId}: agent is in ${agentState} state, must be EXECUTING`,
            })
          }

          try {
            lifecycleManager.steer({
              id: steerMessageId,
              agentId,
              message,
              priority: steerPriority,
              timestamp: new Date(),
            })
          } catch (error) {
            return reply.status(409).send({
              error: "conflict",
              message:
                error instanceof Error ? error.message : "Failed to deliver steering message",
            })
          }
        }

        // Broadcast steer acknowledgment to SSE clients
        sseManager.broadcast(agentId, "steer:ack", {
          agentId,
          steerMessageId,
          timestamp: new Date().toISOString(),
          status: "accepted",
        })

        // Broadcast the steering message as an agent output event
        // so all connected clients see the injection
        sseManager.broadcast(agentId, "agent:output", {
          agentId,
          timestamp: new Date().toISOString(),
          output: {
            type: "text",
            timestamp: new Date().toISOString(),
            content: `[STEER] ${message}`,
          },
        })

        return reply.status(202).send({
          steerMessageId,
          status: "accepted",
          agentId,
          priority: steerPriority,
        })
      },
    )
  }
}
