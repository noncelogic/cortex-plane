/**
 * Agent Credential Binding Routes
 *
 * Endpoints for binding credentials to agents:
 *   POST   /agents/:agentId/credentials              — bind a credential to an agent
 *   GET    /agents/:agentId/credentials              — list agent's credential bindings
 *   DELETE /agents/:agentId/credentials/:credentialId — unbind a credential from an agent
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import type { Database } from "../db/types.js"
import { createRequireAuth, type PreHandler } from "../middleware/auth.js"
import type { AuthConfig, AuthenticatedRequest } from "../middleware/types.js"

export interface AgentCredentialRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function agentCredentialRoutes(deps: AgentCredentialRouteDeps) {
  const { db, authConfig, sessionService } = deps

  const requireAuth: PreHandler = createRequireAuth({
    config: authConfig,
    sessionService,
  })

  return function register(app: FastifyInstance): void {
    /**
     * POST /agents/:agentId/credentials — bind a credential to an agent
     */
    app.post<{
      Params: { agentId: string }
      Body: { credentialId: string }
    }>(
      "/agents/:agentId/credentials",
      {
        preHandler: [requireAuth],
        schema: {
          body: {
            type: "object",
            properties: {
              credentialId: { type: "string", minLength: 1 },
            },
            required: ["credentialId"],
          },
        },
      },
      async (
        request: FastifyRequest<{
          Params: { agentId: string }
          Body: { credentialId: string }
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { agentId } = request.params
        const { credentialId } = request.body

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          reply.status(404).send({ error: "not_found", message: "Agent not found" })
          return
        }

        // Verify credential exists and is active
        const credential = await db
          .selectFrom("provider_credential")
          .select([
            "id",
            "user_account_id",
            "credential_class",
            "provider",
            "display_label",
            "status",
          ])
          .where("id", "=", credentialId)
          .executeTakeFirst()

        if (!credential) {
          reply.status(404).send({ error: "not_found", message: "Credential not found" })
          return
        }

        if (credential.status !== "active") {
          reply.status(400).send({
            error: "bad_request",
            message: "Credential is not active",
          })
          return
        }

        // Authorization: tool_secret requires admin role, others require ownership
        if (credential.credential_class === "tool_specific") {
          if (!principal.roles.includes("admin")) {
            reply.status(403).send({
              error: "forbidden",
              message: "Only admins can bind tool_secret credentials",
            })
            return
          }
        } else {
          if (credential.user_account_id !== principal.userId) {
            reply.status(403).send({
              error: "forbidden",
              message: "You can only bind your own credentials",
            })
            return
          }
        }

        // Check for duplicate binding
        const existing = await db
          .selectFrom("agent_credential_binding")
          .select("id")
          .where("agent_id", "=", agentId)
          .where("provider_credential_id", "=", credentialId)
          .executeTakeFirst()

        if (existing) {
          reply.status(409).send({
            error: "conflict",
            message: "Credential is already bound to this agent",
          })
          return
        }

        // Create the binding
        const binding = await db
          .insertInto("agent_credential_binding")
          .values({
            agent_id: agentId,
            provider_credential_id: credentialId,
          })
          .returningAll()
          .executeTakeFirstOrThrow()

        // Audit log
        await db
          .insertInto("credential_audit_log")
          .values({
            user_account_id: principal.userId,
            provider_credential_id: credentialId,
            event_type: "credential_bound",
            provider: credential.provider,
            details: { agent_id: agentId, binding_id: binding.id, granted_by: principal.userId },
          })
          .execute()

        reply.status(201).send({
          binding: {
            id: binding.id,
            agentId: binding.agent_id,
            credentialId: binding.provider_credential_id,
            credentialClass: credential.credential_class,
            provider: credential.provider,
            displayLabel: credential.display_label,
            grantedBy: principal.userId,
            grantedAt: binding.created_at,
          },
        })
      },
    )

    /**
     * GET /agents/:agentId/credentials — list credential bindings for an agent
     */
    app.get<{ Params: { agentId: string } }>(
      "/agents/:agentId/credentials",
      {
        preHandler: [requireAuth],
      },
      async (request: FastifyRequest<{ Params: { agentId: string } }>, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { agentId } = request.params

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          reply.status(404).send({ error: "not_found", message: "Agent not found" })
          return
        }

        // Query bindings with joined credential metadata
        const rows = await db
          .selectFrom("agent_credential_binding")
          .innerJoin(
            "provider_credential",
            "provider_credential.id",
            "agent_credential_binding.provider_credential_id",
          )
          .select([
            "agent_credential_binding.id",
            "agent_credential_binding.provider_credential_id as credentialId",
            "provider_credential.credential_class as credentialClass",
            "provider_credential.provider",
            "provider_credential.display_label as displayLabel",
            "provider_credential.status",
            "agent_credential_binding.created_at as grantedAt",
          ])
          .where("agent_credential_binding.agent_id", "=", agentId)
          .orderBy("agent_credential_binding.created_at", "asc")
          .execute()

        return {
          bindings: rows,
        }
      },
    )

    /**
     * DELETE /agents/:agentId/credentials/:credentialId — unbind a credential from an agent
     */
    app.delete<{ Params: { agentId: string; credentialId: string } }>(
      "/agents/:agentId/credentials/:credentialId",
      {
        preHandler: [requireAuth],
      },
      async (
        request: FastifyRequest<{ Params: { agentId: string; credentialId: string } }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { agentId, credentialId } = request.params

        // Look up the binding to confirm it exists
        const binding = await db
          .selectFrom("agent_credential_binding")
          .select(["id", "provider_credential_id"])
          .where("agent_id", "=", agentId)
          .where("provider_credential_id", "=", credentialId)
          .executeTakeFirst()

        if (!binding) {
          reply.status(404).send({ error: "not_found", message: "Binding not found" })
          return
        }

        // Look up the credential for audit metadata
        const credential = await db
          .selectFrom("provider_credential")
          .select(["provider"])
          .where("id", "=", credentialId)
          .executeTakeFirst()

        // Delete the binding
        await db
          .deleteFrom("agent_credential_binding")
          .where("agent_id", "=", agentId)
          .where("provider_credential_id", "=", credentialId)
          .execute()

        // Audit log
        await db
          .insertInto("credential_audit_log")
          .values({
            user_account_id: principal.userId,
            provider_credential_id: credentialId,
            event_type: "credential_unbound",
            provider: credential?.provider ?? null,
            details: { agent_id: agentId, binding_id: binding.id },
          })
          .execute()

        return { ok: true }
      },
    )
  }
}
