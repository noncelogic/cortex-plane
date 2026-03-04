/**
 * Agent Control Routes
 *
 * POST /agents/:agentId/dry-run — Simulate an agent turn without tool execution
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import type { Database } from "../db/types.js"
import type { McpToolRouter } from "../mcp/tool-router.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  createRequireRole,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig } from "../middleware/types.js"
import { DryRunError, executeDryRun } from "../observability/dry-run.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface DryRunParams {
  agentId: string
}

interface DryRunBody {
  message: string
  sessionId?: string
  maxTurns?: number
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AgentControlRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sessionService?: SessionService
  mcpToolRouter?: McpToolRouter
}

export function agentControlRoutes(deps: AgentControlRouteDeps) {
  const { db, authConfig, sessionService, mcpToolRouter } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // POST /agents/:agentId/dry-run — Simulate agent turn
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: DryRunParams; Body: DryRunBody }>(
      "/agents/:agentId/dry-run",
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
              message: { type: "string", minLength: 1, maxLength: 50_000 },
              sessionId: { type: "string" },
              maxTurns: { type: "number", minimum: 1, maximum: 5 },
            },
            required: ["message"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: DryRunParams; Body: DryRunBody }>,
        reply: FastifyReply,
      ) => {
        try {
          const result = await executeDryRun(
            request.params.agentId,
            {
              message: request.body.message,
              sessionId: request.body.sessionId,
              maxTurns: request.body.maxTurns,
            },
            { db, mcpToolRouter },
          )

          return reply.status(200).send(result)
        } catch (err) {
          if (err instanceof DryRunError) {
            const statusMap: Record<string, number> = {
              not_found: 404,
              conflict: 409,
            }
            const status = statusMap[err.code] ?? 500
            return reply.status(status).send({ error: err.code, message: err.message })
          }
          throw err
        }
      },
    )
  }
}
