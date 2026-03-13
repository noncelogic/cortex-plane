"use client"

import { useEffect, useState } from "react"

import { listModels, type ModelInfo } from "@/lib/api-client"

/**
 * Hardcoded fallback in case the API is unreachable.
 * Keep in sync with control-plane MODEL_CATALOGUE.
 */
const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    providers: ["anthropic", "google-antigravity"],
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    providers: ["anthropic", "google-antigravity"],
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    providers: ["anthropic", "google-antigravity"],
  },
  { id: "gpt-4o", label: "GPT-4o", providers: ["openai", "openai-codex"] },
  { id: "gpt-4o-mini", label: "GPT-4o Mini", providers: ["openai", "openai-codex"] },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    providers: ["google-antigravity", "google-ai-studio"],
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    providers: ["google-antigravity", "google-ai-studio"],
  },
  {
    id: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    providers: ["google-antigravity", "google-ai-studio"],
  },
]

/**
 * Fetch the model catalogue from the API.
 * Returns the fallback list immediately while loading, then swaps in the API result.
 *
 * @param credentialAware — when true, requests credential-filtered models
 */
export function useModels(opts?: { credentialAware?: boolean }): {
  models: ModelInfo[]
  isLoading: boolean
} {
  const [models, setModels] = useState<ModelInfo[]>(FALLBACK_MODELS)
  const [isLoading, setIsLoading] = useState(true)
  const credentialAware = opts?.credentialAware ?? false

  useEffect(() => {
    let cancelled = false
    listModels({ credentialAware })
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
  }, [credentialAware])

  return { models, isLoading }
}
