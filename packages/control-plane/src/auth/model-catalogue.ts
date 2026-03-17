/**
 * Static model catalogue — fallback for providers whose API does not expose
 * a models listing endpoint (e.g. Google Antigravity returns 404 on /v1/models).
 *
 * Keep this file easy to update: one entry per provider, alphabetical model IDs.
 */

import type { ModelInfo } from "../observability/model-providers.js"

// ---------------------------------------------------------------------------
// Per-provider static model lists
// ---------------------------------------------------------------------------

function models(ids: string[], provider: string): ModelInfo[] {
  return ids.map((id) => ({
    id,
    label: id
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" "),
    providers: [provider],
  }))
}

const STATIC_CATALOGUE: Record<string, ModelInfo[]> = {
  "google-antigravity": models(
    [
      "claude-opus-4-5-thinking",
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-thinking",
      "gemini-3-flash",
      "gemini-3-flash-preview",
      "gemini-3-pro-high",
      "gemini-3-pro-low",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
    ],
    "google-antigravity",
  ),

  anthropic: models(["claude-haiku-3.5", "claude-opus-4", "claude-sonnet-4-5"], "anthropic"),

  "openai-codex": models(["gpt-5", "gpt-5-mini", "gpt-5.2"], "openai-codex"),
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the static model list for `providerId`, or `undefined` if no
 * static catalogue exists for that provider.
 */
export function getStaticModels(providerId: string): ModelInfo[] | undefined {
  return STATIC_CATALOGUE[providerId]
}
