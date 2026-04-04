import { normalizeModelConfigSelection } from "@cortex/shared/llm"
import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"

export interface ActiveLlmBinding {
  id: string
  user_account_id: string | null
  provider: string
  credential_type: string
  credential_class: string
  account_id: string | null
  status: string
}

export interface ResolvedProviderModelContract {
  requestedProvider: string | null
  requestedModel: string | null
  resolvedProvider: string | null
  resolvedModel: string | null
  boundProviders: string[]
  bindingRequired: boolean
  mismatchCode:
    | "provider_unbound"
    | "provider_model_invalid"
    | "model_provider_ambiguous"
    | "model_unknown"
    | "provider_unknown"
    | null
  mismatchMessage: string | null
}

export interface SessionResolutionDiagnostics {
  surface: "channel" | "ui"
  channelType: string
  channelId: string
  chatId: string
  messageId?: string
}

export async function loadActiveLlmBindings(
  db: Kysely<Database>,
  agentId: string,
): Promise<ActiveLlmBinding[]> {
  return db
    .selectFrom("agent_credential_binding")
    .innerJoin(
      "provider_credential",
      "provider_credential.id",
      "agent_credential_binding.provider_credential_id",
    )
    .select([
      "provider_credential.id",
      "provider_credential.user_account_id",
      "provider_credential.provider",
      "provider_credential.credential_type",
      "provider_credential.credential_class",
      "provider_credential.account_id",
      "provider_credential.status",
    ])
    .where("agent_credential_binding.agent_id", "=", agentId)
    .where("provider_credential.credential_class", "=", "llm_provider")
    .where("provider_credential.status", "=", "active")
    .execute()
}

export function resolveProviderModelContract(
  modelConfig: Record<string, unknown> | null | undefined,
  bindings: Pick<ActiveLlmBinding, "provider">[],
): ResolvedProviderModelContract {
  const requestedProvider =
    typeof modelConfig?.provider === "string"
      ? modelConfig.provider
      : typeof modelConfig?.providerId === "string"
        ? modelConfig.providerId
        : null
  const requestedModel = typeof modelConfig?.model === "string" ? modelConfig.model : null
  const boundProviders = [...new Set(bindings.map((binding) => binding.provider))].sort()
  const bindingRequired = requestedProvider !== null || requestedModel !== null
  const normalized = normalizeModelConfigSelection(modelConfig, boundProviders)

  if (!normalized.ok) {
    return {
      requestedProvider,
      requestedModel,
      resolvedProvider: null,
      resolvedModel: requestedModel,
      boundProviders,
      bindingRequired,
      mismatchCode: normalized.error.code,
      mismatchMessage: normalized.error.message,
    }
  }

  return {
    requestedProvider,
    requestedModel,
    resolvedProvider: normalized.selection?.provider ?? null,
    resolvedModel: normalized.selection?.model ?? requestedModel,
    boundProviders,
    bindingRequired,
    mismatchCode: null,
    mismatchMessage: null,
  }
}

export function buildChatDispatchDiagnostics(params: {
  agentId: string
  sessionId: string
  source: SessionResolutionDiagnostics
  providerModel: ResolvedProviderModelContract
  toolRefs?: string[]
  toolContractMode: "effective" | "legacy"
}): Record<string, unknown> {
  return {
    agentId: params.agentId,
    sessionId: params.sessionId,
    source: {
      surface: params.source.surface,
      channelType: params.source.channelType,
      channelId: params.source.channelId,
      chatId: params.source.chatId,
      ...(params.source.messageId ? { messageId: params.source.messageId } : {}),
    },
    providerModel: {
      requestedProvider: params.providerModel.requestedProvider,
      requestedModel: params.providerModel.requestedModel,
      resolvedProvider: params.providerModel.resolvedProvider,
      resolvedModel: params.providerModel.resolvedModel,
      boundProviders: params.providerModel.boundProviders,
      bindingRequired: params.providerModel.bindingRequired,
      mismatchCode: params.providerModel.mismatchCode,
      mismatchMessage: params.providerModel.mismatchMessage,
    },
    tools: {
      mode: params.toolContractMode,
      refs: params.toolRefs ?? [],
      count: params.toolRefs?.length ?? 0,
    },
  }
}
