/**
 * Model Catalogue Routes
 *
 * Endpoints for listing available LLM models:
 *   GET /models — return the full model catalogue
 *   GET /models?credentialAware=true — filter to models the user has credentials for
 */

import type { FastifyInstance, FastifyRequest } from "fastify"

import type { CredentialService } from "../auth/credential-service.js"
import type { SessionService } from "../auth/session-service.js"
import { createRequireAuth, type PreHandler } from "../middleware/auth.js"
import type { AuthenticatedRequest } from "../middleware/types.js"
import { MODEL_CATALOGUE } from "../observability/model-providers.js"

interface ModelRouteDeps {
  credentialService?: CredentialService
  sessionService?: SessionService
}

export function modelRoutes(deps?: ModelRouteDeps) {
  return function register(app: FastifyInstance): void {
    /**
     * GET /models — list all known models with their compatible providers.
     *
     * When ?credentialAware=true and the user is authenticated, filters the
     * catalogue to models where at least one provider matches a user credential.
     * Without the param or when unauthenticated: returns the full catalogue.
     */
    app.get(
      "/models",
      async (request: FastifyRequest<{ Querystring: { credentialAware?: string } }>) => {
        const wantFiltering = request.query.credentialAware === "true"

        if (wantFiltering && deps?.credentialService && deps?.sessionService) {
          // Try to authenticate — build a one-off preHandler
          const requireAuth: PreHandler = createRequireAuth({
            config: { apiKeys: [], requireAuth: true },
            sessionService: deps.sessionService,
          })

          try {
            // Attempt auth — if it fails the preHandler sends a reply, but
            // since we catch, we fall through to return the full catalogue.
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
              const filtered = MODEL_CATALOGUE.filter((m) =>
                m.providers.some((p) => userProviders.has(p)),
              )
              return { models: filtered }
            }
          } catch {
            // Auth failed — fall through to full catalogue
          }
        }

        return { models: MODEL_CATALOGUE }
      },
    )
  }
}
