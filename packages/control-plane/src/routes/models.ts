/**
 * Model Catalogue Routes
 *
 * Endpoints for listing available LLM models:
 *   GET /models — return the full model catalogue
 */

import type { FastifyInstance } from "fastify"

import { MODEL_CATALOGUE } from "../observability/model-providers.js"

export function modelRoutes() {
  return function register(app: FastifyInstance): void {
    /**
     * GET /models — list all known models with their compatible providers.
     *
     * Public endpoint (no auth required) — the catalogue is static metadata.
     */
    app.get("/models", () => {
      return { models: MODEL_CATALOGUE }
    })
  }
}
