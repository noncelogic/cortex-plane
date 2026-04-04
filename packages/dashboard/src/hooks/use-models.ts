"use client"

import { useEffect, useState } from "react"

import {
  listModels,
  type ModelInfo,
  type ProviderModelInfo,
  type SupportedProvider,
} from "@/lib/api-client"

/**
 * Fetch the model catalogue from the API.
 * Starts with an empty list and populates from the API response.
 * Returns empty array when no providers are connected.
 *
 * @param credentialAware — when true, requests credential-filtered models
 */
export function useModels(opts?: { credentialAware?: boolean }): {
  models: ModelInfo[]
  providerModels: ProviderModelInfo[]
  providers: SupportedProvider[]
  isLoading: boolean
} {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [providerModels, setProviderModels] = useState<ProviderModelInfo[]>([])
  const [providers, setProviders] = useState<SupportedProvider[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const credentialAware = opts?.credentialAware ?? false

  useEffect(() => {
    let cancelled = false
    listModels({ credentialAware })
      .then((res) => {
        if (!cancelled) {
          setModels(res.models)
          setProviderModels(res.providerModels)
          setProviders(res.providers)
        }
      })
      .catch(() => {
        // Keep empty on failure
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [credentialAware])

  return { models, providerModels, providers, isLoading }
}
