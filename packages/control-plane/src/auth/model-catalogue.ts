/**
 * Compatibility wrapper around the shared pi-ai-derived contract.
 */

import { listModelsForProvider } from "@cortex/shared/llm"

import type { ModelInfo } from "../observability/model-providers.js"

/**
 * Return the static model list for `providerId`, or `undefined` if no
 * static catalogue exists for that provider.
 */
export function getStaticModels(providerId: string): ModelInfo[] | undefined {
  const models = listModelsForProvider(providerId)
  if (models.length === 0) return undefined
  return models.map((model) => ({
    id: model.modelId,
    label: model.label,
    providers: [model.providerId],
  }))
}
