/**
 * Model-to-provider mapping.
 *
 * Previously a static catalogue; now delegates to ModelDiscoveryService
 * for dynamically discovered models. The lookup helpers remain for
 * backward compatibility with the credential resolver and pricing table.
 */

import { ModelDiscoveryService } from "../auth/model-discovery.js"

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
