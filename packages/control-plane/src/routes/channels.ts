/**
 * Channel Configuration Routes
 *
 * GET    /channels          — List configured channels (summaries, no secrets)
 * POST   /channels          — Add a new channel configuration
 * GET    /channels/:id      — Get a single channel config
 * PUT    /channels/:id      — Update a channel config
 * DELETE /channels/:id      — Remove a channel config
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import type { SessionService } from "../auth/session-service.js"
import type { ChannelConfigService } from "../channels/channel-config-service.js"
import type { ChannelType } from "../db/types.js"
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

interface ChannelIdParams {
  id: string
}

interface DeleteChannelQuery {
  force?: string
}

interface CreateChannelBody {
  type: string
  name: string
  config: Record<string, unknown>
}

interface UpdateChannelBody {
  name?: string
  config?: Record<string, unknown>
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const VALID_CHANNEL_TYPES = new Set<string>(["telegram", "discord", "whatsapp"])

export interface ChannelRouteDeps {
  service: ChannelConfigService
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function channelRoutes(deps: ChannelRouteDeps) {
  const { service, authConfig, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // GET /channels — List all channel configs (masked)
    // -----------------------------------------------------------------
    app.get(
      "/channels",
      { preHandler: [requireAuth, requireOperator] },
      async (_request: FastifyRequest, reply: FastifyReply) => {
        const channels = await service.list()
        return reply.status(200).send({ channels })
      },
    )

    // -----------------------------------------------------------------
    // POST /channels — Create a new channel config
    // -----------------------------------------------------------------
    app.post<{ Body: CreateChannelBody }>(
      "/channels",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          body: {
            type: "object",
            properties: {
              type: { type: "string", minLength: 1 },
              name: { type: "string", minLength: 1 },
              config: { type: "object" },
            },
            required: ["type", "name", "config"],
          },
        },
      },
      async (request: FastifyRequest<{ Body: CreateChannelBody }>, reply: FastifyReply) => {
        const { type, name, config } = request.body

        if (!VALID_CHANNEL_TYPES.has(type)) {
          return reply.status(400).send({
            error: "bad_request",
            message: `Invalid channel type '${type}'. Must be one of: ${[...VALID_CHANNEL_TYPES].join(", ")}`,
          })
        }

        const existing = await service.findByTypeName(type as ChannelType, name)
        if (existing) {
          return reply.status(409).send({
            error: "conflict",
            message: `A ${type} channel named '${name}' already exists`,
          })
        }

        const channel = await service.create(type as ChannelType, name, config, null)
        return reply.status(201).send({ channel })
      },
    )

    // -----------------------------------------------------------------
    // GET /channels/:id — Get a single channel config
    // -----------------------------------------------------------------
    app.get<{ Params: ChannelIdParams }>(
      "/channels/:id",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: ChannelIdParams }>, reply: FastifyReply) => {
        const channel = await service.getById(request.params.id)
        if (!channel) {
          return reply.status(404).send({ error: "not_found", message: "Channel config not found" })
        }
        return reply.status(200).send({ channel })
      },
    )

    // -----------------------------------------------------------------
    // PUT /channels/:id — Update a channel config
    // -----------------------------------------------------------------
    app.put<{ Params: ChannelIdParams; Body: UpdateChannelBody }>(
      "/channels/:id",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          body: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1 },
              config: { type: "object" },
              enabled: { type: "boolean" },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: ChannelIdParams; Body: UpdateChannelBody }>,
        reply: FastifyReply,
      ) => {
        const channel = await service.update(request.params.id, request.body)
        if (!channel) {
          return reply.status(404).send({ error: "not_found", message: "Channel config not found" })
        }
        return reply.status(200).send({ channel })
      },
    )

    // -----------------------------------------------------------------
    // DELETE /channels/:id — Remove a channel config
    // -----------------------------------------------------------------
    app.delete<{ Params: ChannelIdParams; Querystring: DeleteChannelQuery }>(
      "/channels/:id",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          querystring: {
            type: "object",
            properties: { force: { type: "string" } },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: ChannelIdParams; Querystring: DeleteChannelQuery }>,
        reply: FastifyReply,
      ) => {
        const { id } = request.params
        const force = request.query.force === "true"

        const channel = await service.getById(id)
        if (!channel) {
          return reply.status(404).send({ error: "not_found", message: "Channel config not found" })
        }

        const bindings = await service.getBindingsByChannelType(channel.type)
        if (bindings.length > 0 && !force) {
          const agentIds = [...new Set(bindings.map((b) => b.agent_id))]
          return reply.status(409).send({
            error: "conflict",
            message: `Cannot delete channel '${channel.name}': ${agentIds.length} agent(s) bound to channel type '${channel.type}'`,
            bound_agents: agentIds,
          })
        }

        if (bindings.length > 0) {
          await service.removeBindingsByChannelType(channel.type)
        }

        const deleted = await service.delete(id)
        if (!deleted) {
          return reply.status(404).send({ error: "not_found", message: "Channel config not found" })
        }
        return reply.status(200).send({ status: "deleted" })
      },
    )
  }
}
