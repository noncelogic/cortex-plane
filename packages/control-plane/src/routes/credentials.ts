/**
 * Credential Management Routes
 *
 * Endpoints for managing LLM provider credentials:
 *   GET  /credentials           — list user's credentials (masked)
 *   POST /credentials/api-key   — store an API key credential
 *   DELETE /credentials/:id     — delete a credential
 *   GET  /credentials/providers — list supported providers
 *   GET  /credentials/audit     — credential audit log
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { CredentialService, SUPPORTED_PROVIDERS } from "../auth/credential-service.js"
import type { SessionService } from "../auth/session-service.js"
import { createRequireAuth, type PreHandler } from "../middleware/auth.js"
import type { AuthenticatedRequest } from "../middleware/types.js"

interface CredentialRouteDeps {
  credentialService: CredentialService
  sessionService: SessionService
}

export function credentialRoutes(deps: CredentialRouteDeps) {
  const { credentialService, sessionService } = deps

  const requireAuth: PreHandler = createRequireAuth({
    config: { apiKeys: [], requireAuth: true },
    sessionService,
  })

  return function register(app: FastifyInstance): void {
    /**
     * GET /credentials/providers — list supported providers with metadata
     */
    app.get("/credentials/providers", () => {
      return { providers: SUPPORTED_PROVIDERS }
    })

    /**
     * GET /credentials — list user's credentials (no secrets)
     */
    app.get(
      "/credentials",
      { preHandler: [requireAuth] },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const credentials = await credentialService.listCredentials(principal.userId)
        return { credentials }
      },
    )

    /**
     * POST /credentials/api-key — store an API key for a provider
     */
    app.post<{
      Body: {
        provider: string
        apiKey: string
        displayLabel?: string
      }
    }>(
      "/credentials/api-key",
      { preHandler: [requireAuth] },
      async (
        request: FastifyRequest<{
          Body: { provider: string; apiKey: string; displayLabel?: string }
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { provider, apiKey, displayLabel } = request.body

        // Validate provider is a known API key provider
        const providerInfo = SUPPORTED_PROVIDERS.find((p) => p.id === provider)
        if (!providerInfo || providerInfo.authType !== "api_key") {
          reply.status(400).send({
            error: "bad_request",
            message: `Provider '${provider}' does not support API key authentication`,
          })
          return
        }

        if (!apiKey || apiKey.length < 8) {
          reply.status(400).send({
            error: "bad_request",
            message: "API key is required and must be at least 8 characters",
          })
          return
        }

        const credential = await credentialService.storeApiKeyCredential(
          principal.userId,
          provider,
          apiKey,
          { displayLabel },
        )

        reply.status(201).send({ credential })
      },
    )

    /**
     * DELETE /credentials/:id — delete a credential
     */
    app.delete<{ Params: { id: string } }>(
      "/credentials/:id",
      { preHandler: [requireAuth] },
      async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        await credentialService.deleteCredential(principal.userId, request.params.id)
        return { ok: true }
      },
    )

    /**
     * GET /credentials/audit — credential audit log
     */
    app.get<{ Querystring: { limit?: string } }>(
      "/credentials/audit",
      { preHandler: [requireAuth] },
      async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50
        const entries = await credentialService.getAuditLog(principal.userId, Math.min(limit, 200))
        return { entries }
      },
    )
  }
}
