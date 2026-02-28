/**
 * Agent Channel Binding Routes
 *
 * GET    /agents/:agentId/channels            — List channel bindings for an agent
 * POST   /agents/:agentId/channels            — Bind a channel to an agent
 * DELETE /agents/:agentId/channels/:bindingId — Unbind a channel
 * POST   /agents/:agentId/channels/default    — Set as default for a channel type
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import type { SessionService } from "../auth/session-service.js"
import type { AgentChannelService } from "../channels/agent-channel-service.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  createRequireRole,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig } from "../middleware/types.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface AgentChannelParams {
  agentId: string
}

interface BindChannelBody {
  channel_type: string
  chat_id: string
}

interface UnbindChannelParams {
  agentId: string
  bindingId: string
}

interface SetDefaultBody {
  channel_type: string
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AgentChannelRouteDeps {
  service: AgentChannelService
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function agentChannelRoutes(deps: AgentChannelRouteDeps) {
  const { service, authConfig, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // GET /agents/:agentId/channels — List bindings
    // -----------------------------------------------------------------
    app.get<{ Params: AgentChannelParams }>(
      "/agents/:agentId/channels",
      {
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
      async (request: FastifyRequest<{ Params: AgentChannelParams }>, reply: FastifyReply) => {
        const bindings = await service.listBindings(request.params.agentId)
        return reply.status(200).send({ bindings })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/channels — Bind a channel
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: AgentChannelParams; Body: BindChannelBody }>(
      "/agents/:agentId/channels",
      {
        preHandler: [requireAuth, requireOperator],
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
              channel_type: { type: "string", minLength: 1 },
              chat_id: { type: "string", minLength: 1 },
            },
            required: ["channel_type", "chat_id"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentChannelParams; Body: BindChannelBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { channel_type, chat_id } = request.body

        await service.bindChannel(agentId, channel_type, chat_id)

        return reply.status(201).send({
          agent_id: agentId,
          channel_type,
          chat_id,
          status: "bound",
        })
      },
    )

    // -----------------------------------------------------------------
    // DELETE /agents/:agentId/channels/:bindingId — Unbind a channel
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.delete<{ Params: UnbindChannelParams }>(
      "/agents/:agentId/channels/:bindingId",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              bindingId: { type: "string" },
            },
            required: ["agentId", "bindingId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: UnbindChannelParams }>, reply: FastifyReply) => {
        const { agentId, bindingId } = request.params
        const deleted = await service.unbindById(agentId, bindingId)

        if (!deleted) {
          return reply.status(404).send({ error: "not_found", message: "Binding not found" })
        }

        return reply.status(200).send({ status: "unbound" })
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/channels/default — Set default for channel type
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: AgentChannelParams; Body: SetDefaultBody }>(
      "/agents/:agentId/channels/default",
      {
        preHandler: [requireAuth, requireOperator],
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
              channel_type: { type: "string", minLength: 1 },
            },
            required: ["channel_type"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentChannelParams; Body: SetDefaultBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { channel_type } = request.body

        await service.setDefault(agentId, channel_type)

        return reply.status(200).send({
          agent_id: agentId,
          channel_type,
          is_default: true,
        })
      },
    )
  }
}
