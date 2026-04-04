import {
  listCanonicalModels,
  listCompatibleProvidersForModel,
  listModelsForProvider as listContractModelsForProvider,
} from "@cortex/shared/llm"

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

export function providersForModel(modelId: string): string[] | undefined {
  const providers = listCompatibleProvidersForModel(modelId)
  return providers.length > 0 ? providers : undefined
}

export function modelsForProvider(providerId: string): ModelInfo[] {
  return listContractModelsForProvider(providerId).map((model) => ({
    id: model.modelId,
    label: model.label,
    providers: [model.providerId],
  }))
}

export function listAllModels(): ModelInfo[] {
  return listCanonicalModels().map((model) => ({
    id: model.id,
    label: model.label,
    providers: [...model.providers],
  }))
}
