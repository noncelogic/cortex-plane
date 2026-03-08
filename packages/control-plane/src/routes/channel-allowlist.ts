/**
 * Channel Allowlist Routes
 *
 * GET    /channels/:id/allowlist        — List allowlist entries for a channel
 * POST   /channels/:id/allowlist        — Add a user to the allowlist
 * DELETE /channels/:id/allowlist/:entryId — Remove an allowlist entry
 * GET    /channels/:id/policy           — Get inbound policy
 * PUT    /channels/:id/policy           — Set inbound policy
 * GET    /channels/:id/allowlist/audit   — Get allowlist audit log
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import type { SessionService } from "../auth/session-service.js"
import type { ChannelAllowlistService } from "../channels/channel-allowlist-service.js"
import type { ChannelInboundPolicy } from "../db/types.js"
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

interface EntryIdParams {
  id: string
  entryId: string
}

interface AddEntryBody {
  platform_user_id: string
  display_name?: string
  note?: string
}

interface SetPolicyBody {
  policy: string
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const VALID_POLICIES = new Set<string>(["open", "allowlist"])

export interface ChannelAllowlistRouteDeps {
  service: ChannelAllowlistService
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function channelAllowlistRoutes(deps: ChannelAllowlistRouteDeps) {
  const { service, authConfig, sessionService } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // GET /channels/:id/allowlist — List allowlist entries
    // -----------------------------------------------------------------
    app.get<{ Params: ChannelIdParams }>(
      "/channels/:id/allowlist",
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
        const entries = await service.listEntries(request.params.id)
        return reply.status(200).send({ entries })
      },
    )

    // -----------------------------------------------------------------
    // POST /channels/:id/allowlist — Add an entry
    // -----------------------------------------------------------------
    app.post<{ Params: ChannelIdParams; Body: AddEntryBody }>(
      "/channels/:id/allowlist",
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
              platform_user_id: { type: "string", minLength: 1 },
              display_name: { type: "string" },
              note: { type: "string" },
            },
            required: ["platform_user_id"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: ChannelIdParams; Body: AddEntryBody }>,
        reply: FastifyReply,
      ) => {
        const { platform_user_id, display_name, note } = request.body
        const performedBy = (request as unknown as Record<string, string>).userId ?? null

        const entry = await service.addEntry(
          request.params.id,
          platform_user_id,
          performedBy,
          display_name,
          note,
        )
        return reply.status(201).send({ entry })
      },
    )

    // -----------------------------------------------------------------
    // DELETE /channels/:id/allowlist/:entryId — Remove an entry
    // -----------------------------------------------------------------
    app.delete<{ Params: EntryIdParams }>(
      "/channels/:id/allowlist/:entryId",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string" },
              entryId: { type: "string" },
            },
            required: ["id", "entryId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: EntryIdParams }>, reply: FastifyReply) => {
        const performedBy = (request as unknown as Record<string, string>).userId ?? null
        const removed = await service.removeEntry(request.params.entryId, performedBy)
        if (!removed) {
          return reply
            .status(404)
            .send({ error: "not_found", message: "Allowlist entry not found" })
        }
        return reply.status(200).send({ status: "removed" })
      },
    )

    // -----------------------------------------------------------------
    // GET /channels/:id/policy — Get inbound policy
    // -----------------------------------------------------------------
    app.get<{ Params: ChannelIdParams }>(
      "/channels/:id/policy",
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
        const policy = await service.getPolicy(request.params.id)
        if (policy === undefined) {
          return reply.status(404).send({ error: "not_found", message: "Channel config not found" })
        }
        return reply.status(200).send({ policy })
      },
    )

    // -----------------------------------------------------------------
    // PUT /channels/:id/policy — Set inbound policy
    // -----------------------------------------------------------------
    app.put<{ Params: ChannelIdParams; Body: SetPolicyBody }>(
      "/channels/:id/policy",
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
              policy: { type: "string", minLength: 1 },
            },
            required: ["policy"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: ChannelIdParams; Body: SetPolicyBody }>,
        reply: FastifyReply,
      ) => {
        const { policy } = request.body

        if (!VALID_POLICIES.has(policy)) {
          return reply.status(400).send({
            error: "bad_request",
            message: `Invalid policy '${policy}'. Must be one of: ${[...VALID_POLICIES].join(", ")}`,
          })
        }

        const performedBy = (request as unknown as Record<string, string>).userId ?? null
        const updated = await service.setPolicy(
          request.params.id,
          policy as ChannelInboundPolicy,
          performedBy,
        )
        if (!updated) {
          return reply.status(404).send({ error: "not_found", message: "Channel config not found" })
        }
        return reply.status(200).send({ policy })
      },
    )

    // -----------------------------------------------------------------
    // GET /channels/:id/allowlist/audit — Audit log
    // -----------------------------------------------------------------
    app.get<{ Params: ChannelIdParams }>(
      "/channels/:id/allowlist/audit",
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
        const entries = await service.getAuditLog(request.params.id)
        return reply.status(200).send({ entries })
      },
    )
  }
}
