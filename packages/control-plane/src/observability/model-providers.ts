/**
 * Model-to-provider mapping.
 *
 * Maps LLM model IDs to the provider credential IDs that can serve them.
 * Used by the credential resolver in agent-execute to select the correct
 * bound credential for a given model, and by the dashboard to display
 * which models each connected provider enables.
 */

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
// Model catalogue
// ---------------------------------------------------------------------------

/**
 * All known models with their compatible provider credential IDs.
 *
 * Keep in sync with {@link MODEL_PRICING} and the dashboard AVAILABLE_MODELS.
 */
export const MODEL_CATALOGUE: ModelInfo[] = [
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
  {
    id: "gpt-4o",
    label: "GPT-4o",
    providers: ["openai", "openai-codex"],
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o Mini",
    providers: ["openai", "openai-codex"],
  },
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

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const modelMap = new Map(MODEL_CATALOGUE.map((m) => [m.id, m]))

/**
 * Return the provider credential IDs compatible with the given model.
 * Returns `undefined` for unknown models (caller should fall back to
 * any llm_provider credential).
 */
export function providersForModel(modelId: string): string[] | undefined {
  return modelMap.get(modelId)?.providers
}

/**
 * Return the models available through a given provider credential ID.
 */
export function modelsForProvider(providerId: string): ModelInfo[] {
  return MODEL_CATALOGUE.filter((m) => m.providers.includes(providerId))
}
