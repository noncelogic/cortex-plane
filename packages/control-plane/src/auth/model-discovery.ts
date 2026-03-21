/**
 * Dynamic model discovery from LLM provider APIs.
 *
 * Replaces the static MODEL_CATALOGUE with live discovery. Each provider
 * exposes a models endpoint; this service calls them and caches results
 * with a 1-hour TTL.
 */

import type { ModelInfo } from "../observability/model-providers.js"
import { getStaticModels } from "./model-catalogue.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderCredential {
  accessToken?: string
  apiKey?: string
}

interface CacheEntry {
  models: ModelInfo[]
  expiresAt: number
}

// ---------------------------------------------------------------------------
// Provider-specific discovery
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
const OPENAI_CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models"

/** Chat-model filter for OpenAI: keep only models whose id matches these. */
const OPENAI_CHAT_RE = /gpt|o1|o3|o4/i

function labelFromId(id: string): string {
  return id
    .replace(/^models\//, "")
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ")
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Per-provider discovery functions
// ---------------------------------------------------------------------------

async function discoverAnthropic(cred: ProviderCredential): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
  }
  if (cred.apiKey) {
    headers["x-api-key"] = cred.apiKey
  } else if (cred.accessToken) {
    // Anthropic model discovery follows the same x-api-key contract used by
    // the runtime path, even when the credential originated from OAuth.
    headers["x-api-key"] = cred.accessToken
  } else {
    return []
  }

  const data = (await fetchJson("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers,
  })) as { data?: { id: string }[] } | null
  if (!data?.data) return []

  return data.data.map((m) => ({
    id: m.id,
    label: labelFromId(m.id),
    providers: ["anthropic"],
  }))
}

async function discoverOpenAI(
  cred: ProviderCredential,
  providerIds: string[],
  url = OPENAI_MODELS_URL,
): Promise<ModelInfo[]> {
  const token = cred.accessToken ?? cred.apiKey
  if (!token) return []

  const data = (await fetchJson(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })) as { data?: { id: string }[]; models?: { id?: string; slug?: string }[] } | null
  const items =
    data?.data ??
    data?.models?.flatMap((model) => {
      const id = model.id ?? model.slug
      return id ? [{ id }] : []
    })
  if (!items) return []

  return items
    .filter((m) => OPENAI_CHAT_RE.test(m.id))
    .map((m) => ({
      id: m.id,
      label: labelFromId(m.id),
      providers: providerIds,
    }))
}

async function discoverGoogleAIStudio(cred: ProviderCredential): Promise<ModelInfo[]> {
  const key = cred.apiKey
  if (!key) return []

  const data = (await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
    { method: "GET" },
  )) as { models?: { name: string }[] } | null
  if (!data?.models) return []

  return data.models.map((m) => {
    const id = m.name.replace(/^models\//, "")
    return {
      id,
      label: labelFromId(id),
      providers: ["google-ai-studio"],
    }
  })
}

/**
 * Antigravity endpoint candidates for model discovery (prod first, then sandbox).
 * Mirrors the endpoint fallback strategy from the OpenClaw reference.
 */
const ANTIGRAVITY_DISCOVERY_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
] as const

async function discoverGoogleAntigravity(cred: ProviderCredential): Promise<ModelInfo[]> {
  const token = cred.accessToken
  if (!token) return []

  const envUrl = process.env.ANTIGRAVITY_BASE_URL
  const endpoints = envUrl ? [envUrl] : [...ANTIGRAVITY_DISCOVERY_ENDPOINTS]

  // Try each endpoint with Anthropic-format models endpoint
  for (const baseUrl of endpoints) {
    const data = (await fetchJson(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
    })) as { data?: { id: string }[] } | null
    if (data?.data && data.data.length > 0) {
      return data.data.map((m) => ({
        id: m.id,
        label: labelFromId(m.id),
        providers: ["google-antigravity"],
      }))
    }
  }

  return []
}

async function discoverGitHubCopilot(cred: ProviderCredential): Promise<ModelInfo[]> {
  const token = cred.accessToken
  if (!token) return []

  const data = (await fetchJson("https://api.githubcopilot.com/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })) as { data?: { id: string }[] } | { id: string }[] | null
  if (!data) return []

  // Response may be { data: [...] } or directly [...]
  const items = Array.isArray(data) ? data : (data as { data?: { id: string }[] }).data
  if (!items) return []

  return items.map((m) => ({
    id: m.id,
    label: labelFromId(m.id),
    providers: ["github-copilot"],
  }))
}

async function discoverGeminiCli(cred: ProviderCredential): Promise<ModelInfo[]> {
  const token = cred.accessToken
  if (!token) return []

  // Same as Google AI Studio but with OAuth bearer instead of API key
  const data = (await fetchJson("https://generativelanguage.googleapis.com/v1beta/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  })) as { models?: { name: string }[] } | null
  if (!data?.models) return []

  return data.models.map((m) => {
    const id = m.name.replace(/^models\//, "")
    return {
      id,
      label: labelFromId(id),
      providers: ["google-gemini-cli"],
    }
  })
}

// ---------------------------------------------------------------------------
// ModelDiscoveryService
// ---------------------------------------------------------------------------

export class ModelDiscoveryService {
  private cache = new Map<string, CacheEntry>()

  /**
   * Discover models from a provider's API.
   * Results are cached with 1h TTL.
   */
  async discoverModels(providerId: string, credential: ProviderCredential): Promise<ModelInfo[]> {
    let models: ModelInfo[]

    switch (providerId) {
      case "anthropic":
        models = await discoverAnthropic(credential)
        break
      case "openai":
        models = await discoverOpenAI(credential, ["openai"])
        break
      case "openai-codex":
        models = await discoverOpenAI(credential, ["openai-codex"], OPENAI_CODEX_MODELS_URL)
        break
      case "google-ai-studio":
        models = await discoverGoogleAIStudio(credential)
        break
      case "google-antigravity":
        models = await discoverGoogleAntigravity(credential)
        break
      case "github-copilot":
        models = await discoverGitHubCopilot(credential)
        break
      case "google-gemini-cli":
        models = await discoverGeminiCli(credential)
        break
      default:
        models = []
    }

    // Fall back to static catalogue when dynamic discovery returns empty
    if (models.length === 0) {
      const fallback = getStaticModels(providerId)
      if (fallback) {
        console.warn(
          `[model-discovery] Dynamic discovery returned empty for "${providerId}" — using static model catalogue`,
        )
        models = fallback
      }
    }

    if (models.length > 0) {
      this.cache.set(providerId, {
        models,
        expiresAt: Date.now() + CACHE_TTL_MS,
      })
    }

    return models
  }

  /**
   * Return cached models for a provider, or empty array if cache is
   * empty / expired.
   */
  getCachedModels(providerId: string): ModelInfo[] {
    const entry = this.cache.get(providerId)
    if (!entry || Date.now() > entry.expiresAt) return []
    return entry.models
  }

  /**
   * Return all discovered models across all cached providers.
   * Deduplicates by model ID, merging provider arrays.
   */
  getAllCachedModels(): ModelInfo[] {
    const merged = new Map<string, ModelInfo>()
    for (const entry of this.cache.values()) {
      if (Date.now() > entry.expiresAt) continue
      for (const m of entry.models) {
        const existing = merged.get(m.id)
        if (existing) {
          const providerSet = new Set([...existing.providers, ...m.providers])
          existing.providers = [...providerSet]
        } else {
          merged.set(m.id, { ...m, providers: [...m.providers] })
        }
      }
    }
    return [...merged.values()]
  }

  /**
   * Invalidate cache for a specific provider (e.g. on credential add/remove).
   */
  invalidate(providerId: string): void {
    this.cache.delete(providerId)
  }

  /**
   * Invalidate all cached models.
   */
  invalidateAll(): void {
    this.cache.clear()
  }
}
