import { getModels as getPiAiModels } from "@mariozechner/pi-ai"

export type LlmProviderId =
  | "anthropic"
  | "google-ai-studio"
  | "google-antigravity"
  | "google-gemini-cli"
  | "github-copilot"
  | "openai"
  | "openai-codex"

export type ProviderAuthType = "oauth" | "api_key"

export interface LlmProviderInfo {
  id: LlmProviderId
  name: string
  description: string
  authType: ProviderAuthType
  oauthConnectMode?: "redirect" | "popup" | "code_paste"
  credentialClass: "llm_provider"
  isOAuthBacked: boolean
  isStaticApiKey: boolean
}

export interface ProviderModelCapability {
  providerId: LlmProviderId
  modelId: string
  label: string
  api: string
  reasoning: boolean
  input: string[]
  contextWindow: number
  maxTokens: number
  baseUrl: string
}

export interface CanonicalModelInfo {
  id: string
  label: string
  providers: LlmProviderId[]
}

export interface NormalizedProviderModelSelection {
  provider: LlmProviderId
  model: string
  capability: ProviderModelCapability
}

export type ProviderModelValidationCode =
  | "provider_unknown"
  | "model_unknown"
  | "provider_model_invalid"
  | "model_provider_ambiguous"
  | "provider_unbound"

export interface ProviderModelValidationError {
  code: ProviderModelValidationCode
  message: string
}

export type ProviderModelValidationResult =
  | { ok: true; selection: NormalizedProviderModelSelection }
  | { ok: false; error: ProviderModelValidationError }

type PiAiProviderId =
  | "anthropic"
  | "github-copilot"
  | "google"
  | "google-antigravity"
  | "google-gemini-cli"
  | "openai"
  | "openai-codex"

interface ProviderDefinition {
  id: LlmProviderId
  piAiProviderId: PiAiProviderId
  name: string
  description: string
  authType: ProviderAuthType
  oauthConnectMode?: "redirect" | "popup" | "code_paste"
}

const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: "anthropic",
    piAiProviderId: "anthropic",
    name: "Anthropic",
    description: "Claude models via OAuth",
    authType: "oauth",
    oauthConnectMode: "code_paste",
  },
  {
    id: "google-ai-studio",
    piAiProviderId: "google",
    name: "Google AI Studio",
    description: "Gemini models via API key",
    authType: "api_key",
  },
  {
    id: "google-antigravity",
    piAiProviderId: "google-antigravity",
    name: "Google Antigravity",
    description: "Claude/Gemini via Google Cloud Antigravity",
    authType: "oauth",
    oauthConnectMode: "popup",
  },
  {
    id: "google-gemini-cli",
    piAiProviderId: "google-gemini-cli",
    name: "Google Gemini CLI",
    description: "Gemini models via Google Gemini CLI OAuth",
    authType: "oauth",
    oauthConnectMode: "popup",
  },
  {
    id: "github-copilot",
    piAiProviderId: "github-copilot",
    name: "GitHub Copilot",
    description: "GPT/Claude models via GitHub Copilot subscription",
    authType: "oauth",
    oauthConnectMode: "popup",
  },
  {
    id: "openai",
    piAiProviderId: "openai",
    name: "OpenAI",
    description: "GPT models via direct API key",
    authType: "api_key",
  },
  {
    id: "openai-codex",
    piAiProviderId: "openai-codex",
    name: "OpenAI Codex",
    description: "GPT models via ChatGPT subscription",
    authType: "oauth",
    oauthConnectMode: "popup",
  },
] as const

const PROVIDER_INFO: readonly LlmProviderInfo[] = PROVIDER_DEFINITIONS.map((provider) => ({
  id: provider.id,
  name: provider.name,
  description: provider.description,
  authType: provider.authType,
  oauthConnectMode: provider.oauthConnectMode,
  credentialClass: "llm_provider",
  isOAuthBacked: provider.authType === "oauth",
  isStaticApiKey: provider.authType === "api_key",
}))

const PROVIDER_INFO_BY_ID = new Map(PROVIDER_INFO.map((provider) => [provider.id, provider]))

const PROVIDER_MODEL_CAPABILITIES: readonly ProviderModelCapability[] =
  PROVIDER_DEFINITIONS.flatMap((provider) =>
    getPiAiModels(provider.piAiProviderId).map((model) => ({
      providerId: provider.id,
      modelId: model.id,
      label: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      baseUrl: model.baseUrl,
    })),
  )

const PROVIDER_MODEL_BY_KEY = new Map(
  PROVIDER_MODEL_CAPABILITIES.map((capability) => [
    makeProviderModelKey(capability.providerId, capability.modelId),
    capability,
  ]),
)

const MODELS_BY_PROVIDER = new Map<LlmProviderId, ProviderModelCapability[]>(
  PROVIDER_DEFINITIONS.map((provider) => [provider.id, []]),
)
for (const capability of PROVIDER_MODEL_CAPABILITIES) {
  MODELS_BY_PROVIDER.get(capability.providerId)?.push(capability)
}

const CANONICAL_MODELS: CanonicalModelInfo[] = []
const CANONICAL_MODELS_BY_ID = new Map<string, CanonicalModelInfo>()
for (const capability of PROVIDER_MODEL_CAPABILITIES) {
  const existing = CANONICAL_MODELS_BY_ID.get(capability.modelId)
  if (existing) {
    if (!existing.providers.includes(capability.providerId)) {
      existing.providers.push(capability.providerId)
      existing.providers.sort()
    }
    continue
  }

  const next: CanonicalModelInfo = {
    id: capability.modelId,
    label: capability.label,
    providers: [capability.providerId],
  }
  CANONICAL_MODELS_BY_ID.set(capability.modelId, next)
  CANONICAL_MODELS.push(next)
}

CANONICAL_MODELS.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))

function makeProviderModelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}

export function listSupportedLlmProviders(): LlmProviderInfo[] {
  return PROVIDER_INFO.map((provider) => ({ ...provider }))
}

export function getSupportedLlmProvider(providerId: string): LlmProviderInfo | undefined {
  const provider = PROVIDER_INFO_BY_ID.get(providerId as LlmProviderId)
  return provider ? { ...provider } : undefined
}

export function listProviderModelCapabilities(): ProviderModelCapability[] {
  return PROVIDER_MODEL_CAPABILITIES.map((capability) => ({
    ...capability,
    input: [...capability.input],
  }))
}

export function listModelsForProvider(providerId: string): ProviderModelCapability[] {
  return (MODELS_BY_PROVIDER.get(providerId as LlmProviderId) ?? []).map((capability) => ({
    ...capability,
    input: [...capability.input],
  }))
}

export function listCanonicalModels(): CanonicalModelInfo[] {
  return CANONICAL_MODELS.map((model) => ({
    ...model,
    providers: [...model.providers],
  }))
}

export function listCompatibleProvidersForModel(modelId: string): LlmProviderId[] {
  return [...(CANONICAL_MODELS_BY_ID.get(modelId)?.providers ?? [])]
}

export function getProviderModelCapability(
  providerId: string,
  modelId: string,
): ProviderModelCapability | undefined {
  const capability = PROVIDER_MODEL_BY_KEY.get(makeProviderModelKey(providerId, modelId))
  return capability
    ? {
        ...capability,
        input: [...capability.input],
      }
    : undefined
}

export function validateProviderModelSelection(params: {
  provider?: string | null
  model?: string | null
  allowedProviders?: string[] | null
}): ProviderModelValidationResult | null {
  const model = params.model?.trim() ?? ""
  const explicitProvider = params.provider?.trim() ?? ""

  if (!model && !explicitProvider) return null
  if (!model) {
    return {
      ok: false,
      error: {
        code: "model_unknown",
        message: "Model is required when provider is set",
      },
    }
  }

  if (explicitProvider) {
    const provider = getSupportedLlmProvider(explicitProvider)
    if (!provider) {
      return {
        ok: false,
        error: {
          code: "provider_unknown",
          message: `Provider '${explicitProvider}' is not supported`,
        },
      }
    }

    const capability = getProviderModelCapability(explicitProvider, model)
    if (!capability) {
      return {
        ok: false,
        error: {
          code: "provider_model_invalid",
          message: `Model '${model}' is not available for provider '${explicitProvider}'`,
        },
      }
    }

    if (
      params.allowedProviders &&
      params.allowedProviders.length > 0 &&
      !params.allowedProviders.includes(explicitProvider)
    ) {
      return {
        ok: false,
        error: {
          code: "provider_unbound",
          message: `Provider '${explicitProvider}' is not currently bound to this agent`,
        },
      }
    }

    return {
      ok: true,
      selection: {
        provider: capability.providerId,
        model: capability.modelId,
        capability,
      },
    }
  }

  const providers = listCompatibleProvidersForModel(model)
  if (providers.length === 0) {
    return {
      ok: false,
      error: {
        code: "model_unknown",
        message: `Model '${model}' is not supported`,
      },
    }
  }

  const allowedProviders = params.allowedProviders?.filter((provider) =>
    providers.includes(provider as LlmProviderId),
  )
  const resolvedProviders =
    allowedProviders && allowedProviders.length > 0 ? allowedProviders : providers
  if (resolvedProviders.length !== 1) {
    return {
      ok: false,
      error: {
        code: "model_provider_ambiguous",
        message:
          allowedProviders && allowedProviders.length === 0
            ? `Model '${model}' does not match any currently bound provider`
            : `Model '${model}' matches multiple providers; specify provider explicitly`,
      },
    }
  }

  const capability = getProviderModelCapability(resolvedProviders[0]!, model)
  if (!capability) {
    return {
      ok: false,
      error: {
        code: "provider_model_invalid",
        message: `Model '${model}' is not available for provider '${resolvedProviders[0]}'`,
      },
    }
  }

  return {
    ok: true,
    selection: {
      provider: capability.providerId,
      model: capability.modelId,
      capability,
    },
  }
}

export function normalizeModelConfigSelection(
  modelConfig: Record<string, unknown> | null | undefined,
  allowedProviders?: string[] | null,
):
  | {
      ok: true
      modelConfig: Record<string, unknown>
      selection: NormalizedProviderModelSelection | null
    }
  | { ok: false; error: ProviderModelValidationError } {
  const nextModelConfig = { ...(modelConfig ?? {}) }
  const provider =
    typeof nextModelConfig.provider === "string"
      ? nextModelConfig.provider
      : typeof nextModelConfig.providerId === "string"
        ? nextModelConfig.providerId
        : undefined
  const model = typeof nextModelConfig.model === "string" ? nextModelConfig.model : undefined

  const validation = validateProviderModelSelection({ provider, model, allowedProviders })
  if (!validation) {
    delete nextModelConfig.provider
    delete nextModelConfig.providerId
    return { ok: true, modelConfig: nextModelConfig, selection: null }
  }

  if (!validation.ok) {
    return { ok: false, error: validation.error }
  }

  nextModelConfig.provider = validation.selection.provider
  delete nextModelConfig.providerId
  nextModelConfig.model = validation.selection.model

  return {
    ok: true,
    modelConfig: nextModelConfig,
    selection: validation.selection,
  }
}
