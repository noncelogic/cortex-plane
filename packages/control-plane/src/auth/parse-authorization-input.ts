/**
 * Parse authorization input from the code-paste flow.
 *
 * Users may paste:
 * - A full redirect URL with query params: http://localhost:51121/oauth-callback?code=xxx&state=yyy
 * - An Anthropic code#state format: CODE#STATE  (or the full URL with this fragment)
 * - A raw authorization code string
 */

export interface ParsedAuthorization {
  code: string
  state?: string
}

export function parseAuthorizationInput(
  input: string,
  provider: string,
): ParsedAuthorization | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Try parsing as a URL first
  try {
    const url = new URL(trimmed)

    // Check for Anthropic code#state in the hash/fragment
    if (provider === "anthropic" && url.hash) {
      const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash
      // Anthropic format: the path after callback contains code, hash contains state
      // URL looks like: https://console.anthropic.com/oauth/code/callback?code=CODE#STATE
      const code = url.searchParams.get("code")
      if (code) {
        return { code, state: fragment || undefined }
      }
      // Or the fragment itself could be code#state
      return parseCodeHashState(fragment)
    }

    // Standard URL with ?code=xxx&state=yyy
    const code = url.searchParams.get("code")
    if (code) {
      return {
        code,
        state: url.searchParams.get("state") ?? undefined,
      }
    }
  } catch {
    // Not a valid URL — continue to other formats
  }

  // Check for Anthropic code#state format (raw, not in a URL)
  if (provider === "anthropic" && trimmed.includes("#")) {
    const result = parseCodeHashState(trimmed)
    if (result) return result
  }

  // Treat as a raw authorization code
  if (trimmed.length > 0) {
    return { code: trimmed }
  }

  return null
}

function parseCodeHashState(input: string): ParsedAuthorization | null {
  const hashIdx = input.indexOf("#")
  if (hashIdx === -1) return null

  const code = input.slice(0, hashIdx)
  const state = input.slice(hashIdx + 1)

  if (!code) return null

  return { code, state: state || undefined }
}
