import type {
  CredentialTestResult,
  OAuthConnectExchangeResult,
  ProviderInfo,
} from "@/lib/api-client"

function providerLabel(providerId: string | null, providers: ProviderInfo[]): string | null {
  if (!providerId) return null
  return providers.find((provider) => provider.id === providerId)?.name ?? providerId
}

export function isVerificationFailureResult(
  result: OAuthConnectExchangeResult,
): result is Extract<OAuthConnectExchangeResult, { ok: false }> {
  return result.ok === false
}

export function formatConnectErrorMessage(params: {
  error: string | null
  provider: string | null
  reason: string | null
  providers: ProviderInfo[]
}): string | null {
  const { error, provider, reason, providers } = params
  if (!error) return null

  if (error === "connect_unverified") {
    const label = providerLabel(provider, providers) ?? "Provider"
    const suffix = reason ? `: ${reason}` : "."
    return `${label} connection failed verification${suffix}`
  }

  return `Connection error: ${error}`
}

export function formatVerificationFailureMessage(
  provider: string,
  verification: CredentialTestResult,
): string {
  return `${provider} connection failed verification: ${verification.message}`
}
