/**
 * Model-to-provider mapping.
 *
 * Previously a static catalogue; now delegates to ModelDiscoveryService
 * for dynamically discovered models. The lookup helpers remain for
 * backward compatibility with the credential resolver and pricing table.
 */

import type { Kysely } from "kysely"

import { ModelDiscoveryService } from "../auth/model-discovery.js"
import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string
  label: string
  /** Provider credential IDs that can serve this model. */
  providers: string[]
}

// ---------------------------------------------------------------------------
// Shared discovery service singleton
// ---------------------------------------------------------------------------

export const modelDiscoveryService = new ModelDiscoveryService()

/**
 * Attach a DB connection to the singleton discovery service so it can
 * persist and reload discovered models across restarts.
 */
export function initModelDiscoveryDb(db: Kysely<Database>): void {
  modelDiscoveryService.setDb(db)
}

// ---------------------------------------------------------------------------
// Lookup helpers (read from discovery cache)
// ---------------------------------------------------------------------------

/**
 * Return the provider credential IDs compatible with the given model.
 * Returns `undefined` for unknown models (caller should fall back to
 * any llm_provider credential).
 */
export function providersForModel(modelId: string): string[] | undefined {
  const all = modelDiscoveryService.getAllCachedModels()
  const found = all.find((m) => m.id === modelId)
  return found?.providers
}

/**
 * Return the models available through a given provider credential ID.
 */
export function modelsForProvider(providerId: string): ModelInfo[] {
  return modelDiscoveryService.getCachedModels(providerId)
}
