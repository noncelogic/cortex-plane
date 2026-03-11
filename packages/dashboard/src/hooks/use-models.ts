"use client"

import { useEffect, useState } from "react"

import { listModels, type ModelInfo } from "@/lib/api-client"

/**
 * Hardcoded fallback in case the API is unreachable.
 * Keep in sync with control-plane MODEL_CATALOGUE.
 */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", providers: ["anthropic", "google-antigravity"] },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", providers: ["anthropic", "google-antigravity"] },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", providers: ["anthropic", "google-antigravity"] },
  { id: "gpt-4o", label: "GPT-4o", providers: ["openai", "openai-codex"] },
  { id: "gpt-4o-mini", label: "GPT-4o Mini", providers: ["openai", "openai-codex"] },
]

/**
 * Fetch the model catalogue from the API.
 * Returns the fallback list immediately while loading, then swaps in the API result.
 */
export function useModels(): { models: ModelInfo[]; isLoading: boolean } {
  const [models, setModels] = useState<ModelInfo[]>(FALLBACK_MODELS)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    listModels()
      .then((res) => {
        if (!cancelled && res.models.length > 0) {
          setModels(res.models)
        }
      })
      .catch(() => {
        // Keep fallback models on failure
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { models, isLoading }
}
