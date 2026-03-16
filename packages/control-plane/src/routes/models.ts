/**
 * Model Catalogue Routes
 *
 * Endpoints for listing available LLM models:
 *   GET  /models — return discovered models (optionally credential-filtered)
 *   POST /models/refresh — force re-discovery from provider APIs
 */

import type { FastifyInstance, FastifyRequest } from "fastify"

import type { CredentialService } from "../auth/credential-service.js"
import type { ModelDiscoveryService } from "../auth/model-discovery.js"
import type { SessionService } from "../auth/session-service.js"
import { createRequireAuth, type PreHandler } from "../middleware/auth.js"
import type { AuthenticatedRequest } from "../middleware/types.js"
import { modelDiscoveryService } from "../observability/model-providers.js"

interface ModelRouteDeps {
  credentialService?: CredentialService
  sessionService?: SessionService
  discoveryService?: ModelDiscoveryService
}

export function modelRoutes(deps?: ModelRouteDeps) {
  const discovery = deps?.discoveryService ?? modelDiscoveryService

  return function register(app: FastifyInstance): void {
    /**
     * GET /models — list all discovered models with their compatible providers.
     *
     * When ?credentialAware=true and the user is authenticated, filters to
     * models where at least one provider matches a user credential.
     * Without the param or when unauthenticated: returns all cached models.
     */
    app.get(
      "/models",
      async (request: FastifyRequest<{ Querystring: { credentialAware?: string } }>) => {
        const allModels = discovery.getAllCachedModels()
        const wantFiltering = request.query.credentialAware === "true"

        if (wantFiltering && deps?.credentialService && deps?.sessionService) {
          const requireAuth: PreHandler = createRequireAuth({
            config: { apiKeys: [], requireAuth: true },
            sessionService: deps.sessionService,
          })

          try {
            const fakeReply = {
              sent: false,
              code(status: number) {
                this.sent = true
                this._status = status
                return this
              },
              _status: 200,
              send() {
                this.sent = true
                return this
              },
            }
            await requireAuth(request, fakeReply as unknown as import("fastify").FastifyReply)

            if (!fakeReply.sent) {
              const principal = (request as AuthenticatedRequest).principal
              const credentials = await deps.credentialService.listCredentials(principal.userId, {
                credentialClass: "llm_provider",
              })
              const userProviders = new Set(credentials.map((c) => c.provider))
              const filtered = allModels.filter((m) =>
                m.providers.some((p) => userProviders.has(p)),
              )
              return { models: filtered }
            }
          } catch {
            // Auth failed — fall through to full catalogue
          }
        }

        return { models: allModels }
      },
    )

    /**
     * POST /models/refresh — force re-discovery of models from provider APIs.
     *
     * Requires authentication. Iterates over the user's llm_provider credentials,
     * calls the provider's models API, and refreshes the cache.
     */
    app.post("/models/refresh", async (request: FastifyRequest, reply) => {
      if (!deps?.credentialService || !deps?.sessionService) {
        reply
          .status(501)
          .send({ error: "not_configured", message: "Credential service not available" })
        return
      }

      const requireAuth: PreHandler = createRequireAuth({
        config: { apiKeys: [], requireAuth: true },
        sessionService: deps.sessionService,
      })

      const fakeReply = {
        sent: false,
        code(status: number) {
          this.sent = true
          this._status = status
          return this
        },
        _status: 200,
        send() {
          this.sent = true
          return this
        },
      }
      await requireAuth(request, fakeReply as unknown as import("fastify").FastifyReply)

      if (fakeReply.sent) {
        reply.status(401).send({ error: "unauthorized" })
        return
      }

      const principal = (request as AuthenticatedRequest).principal
      const credentials = await deps.credentialService.listCredentials(principal.userId, {
        credentialClass: "llm_provider",
      })

      let discovered = 0
      for (const cred of credentials) {
        // We cannot decrypt tokens here — the discovery service accepts
        // the token directly. For refresh we use getAccessToken which
        // decrypts and refreshes as needed.
        const tokenResult = await deps.credentialService.getAccessToken(
          principal.userId,
          cred.provider,
        )
        if (!tokenResult) continue

        const models = await discovery.discoverModels(cred.provider, {
          accessToken: tokenResult.token,
          apiKey: cred.credentialType === "api_key" ? tokenResult.token : undefined,
          baseUrl: cred.baseUrl ?? undefined,
        })
        discovered += models.length
      }

      return { ok: true, modelsDiscovered: discovered }
    })
  }
}
