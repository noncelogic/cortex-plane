/**
 * Credential Management Routes
 *
 * Endpoints for managing LLM provider credentials:
 *   GET  /credentials              — list user's credentials (masked)
 *   POST /credentials/api-key      — store an API key credential
 *   POST /credentials/tool-secret  — store a tool secret (admin only)
 *   PUT  /credentials/:id/rotate   — rotate a tool secret (admin only)
 *   DELETE /credentials/:id        — delete a credential
 *   GET  /credentials/providers    — list supported providers
 *   GET  /credentials/audit        — credential audit log
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import {
  CredentialService,
  SUPPORTED_PROVIDERS,
  getConfiguredProviders,
} from "../auth/credential-service.js"
import type { AuthOAuthConfig } from "../config.js"
import type { ModelDiscoveryService } from "../auth/model-discovery.js"
import type { SessionService } from "../auth/session-service.js"
import { createRequireAuth, createRequireRole, type PreHandler } from "../middleware/auth.js"
import type { AuthenticatedRequest } from "../middleware/types.js"
import { modelsForProvider } from "../observability/model-providers.js"

const TOOL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

interface CredentialRouteDeps {
  credentialService: CredentialService
  sessionService: SessionService
  modelDiscovery?: ModelDiscoveryService
  authConfig?: AuthOAuthConfig
}

export function credentialRoutes(deps: CredentialRouteDeps) {
  const { credentialService, sessionService, modelDiscovery, authConfig } = deps

  const requireAuth: PreHandler = createRequireAuth({
    config: { apiKeys: [], requireAuth: true },
    sessionService,
  })

  const requireAdmin: PreHandler = createRequireRole("admin")

  return function register(app: FastifyInstance): void {
    /**
     * GET /credentials/providers — list supported providers with metadata
     */
    app.get("/credentials/providers", () => {
      const configured = getConfiguredProviders(authConfig)
      const providers = configured.map((p) => {
        const models = modelsForProvider(p.id)
        return models.length > 0
          ? { ...p, models: models.map((m) => ({ id: m.id, label: m.label })) }
          : p
      })
      return { providers }
    })

    /**
     * GET /credentials — list user's credentials (no secrets)
     * ?class=tool_specific  → admin-only list of tool secrets (cross-user)
     */
    app.get<{
      Querystring: { class?: string }
    }>(
      "/credentials",
      { preHandler: [requireAuth] },
      async (request: FastifyRequest<{ Querystring: { class?: string } }>, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        // Tool secret listing is admin-only and cross-user
        if (request.query.class === "tool_specific") {
          if (!principal.roles.includes("admin")) {
            reply.status(403).send({
              error: "forbidden",
              message: "Role 'admin' required",
            })
            return
          }
          const credentials = await credentialService.listToolSecrets(principal.userId)
          return { credentials }
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

        // Auto-trigger model discovery for the new credential (fire-and-forget)
        if (modelDiscovery) {
          modelDiscovery.discoverModels(provider, { apiKey }).catch(() => {})
        }

        reply.status(201).send({ credential })
      },
    )

    /**
     * POST /credentials/tool-secret — store a tool secret (admin only)
     */
    app.post<{
      Body: {
        toolName: string
        provider: string
        apiKey: string
        displayLabel?: string
      }
    }>(
      "/credentials/tool-secret",
      { preHandler: [requireAuth, requireAdmin] },
      async (
        request: FastifyRequest<{
          Body: { toolName: string; provider: string; apiKey: string; displayLabel?: string }
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { toolName, provider, apiKey, displayLabel } = request.body

        if (!toolName || !TOOL_NAME_RE.test(toolName)) {
          reply.status(400).send({
            error: "bad_request",
            message:
              "toolName is required: 1-64 chars, lowercase alphanumeric + hyphens, must start with alphanumeric",
          })
          return
        }

        if (!provider || provider.length === 0) {
          reply.status(400).send({
            error: "bad_request",
            message: "provider is required",
          })
          return
        }

        if (!apiKey || apiKey.length < 8) {
          reply.status(400).send({
            error: "bad_request",
            message: "apiKey is required and must be at least 8 characters",
          })
          return
        }

        const credential = await credentialService.storeToolSecret(
          principal.userId,
          toolName,
          provider,
          apiKey,
          { displayLabel },
        )

        reply.status(201).send({ credential })
      },
    )

    /**
     * PUT /credentials/:id/rotate — rotate a tool secret (admin only)
     */
    app.put<{
      Params: { id: string }
      Body: { apiKey: string; toolName?: string }
    }>(
      "/credentials/:id/rotate",
      { preHandler: [requireAuth, requireAdmin] },
      async (
        request: FastifyRequest<{
          Params: { id: string }
          Body: { apiKey: string; toolName?: string }
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { apiKey, toolName } = request.body

        if (toolName !== undefined && !TOOL_NAME_RE.test(toolName)) {
          reply.status(400).send({
            error: "bad_request",
            message:
              "toolName is required: 1-64 chars, lowercase alphanumeric + hyphens, must start with alphanumeric",
          })
          return
        }

        if (!apiKey || apiKey.length < 8) {
          reply.status(400).send({
            error: "bad_request",
            message: "apiKey is required and must be at least 8 characters",
          })
          return
        }

        const credential = await credentialService.rotateToolSecret(
          principal.userId,
          request.params.id,
          apiKey,
        )

        if (!credential) {
          reply.status(404).send({
            error: "not_found",
            message: "Tool secret not found",
          })
          return
        }

        return { credential }
      },
    )

    /**
     * POST /credentials/:id/test — test a credential by pinging the provider
     */
    app.post<{ Params: { id: string } }>(
      "/credentials/:id/test",
      { preHandler: [requireAuth] },
      async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const result = await credentialService.testCredential(principal.userId, request.params.id)
        return result
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
     * GET /credentials/audit — credential audit log with optional filters
     */
    app.get<{
      Querystring: {
        limit?: string
        credentialId?: string
        agentId?: string
        eventType?: string
      }
    }>(
      "/credentials/audit",
      { preHandler: [requireAuth] },
      async (
        request: FastifyRequest<{
          Querystring: {
            limit?: string
            credentialId?: string
            agentId?: string
            eventType?: string
          }
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50
        const entries = await credentialService.getAuditLog(principal.userId, {
          limit: Math.min(limit, 200),
          credentialId: request.query.credentialId,
          agentId: request.query.agentId,
          eventType: request.query.eventType,
        })
        return { entries }
      },
    )
  }
}
