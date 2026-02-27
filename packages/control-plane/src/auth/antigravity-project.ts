/**
 * Antigravity Project Discovery
 *
 * After Google Antigravity OAuth, discovers the user's Google Cloud project
 * by calling the cloudcode-pa API. Tries production endpoint first, then
 * falls back to sandbox, then returns a default.
 */

const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
const SANDBOX_ENDPOINT =
  "https://staging-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist"
const DEFAULT_PROJECT = "anthropic-cortex-default"

interface CodeAssistResponse {
  projectId?: string
  project?: string
}

/**
 * Discover the user's GCP project ID for Antigravity.
 * Returns the project ID or a default fallback.
 */
export async function discoverAntigravityProject(accessToken: string): Promise<string> {
  // Try production endpoint first
  const prodProject = await tryLoadCodeAssist(PROD_ENDPOINT, accessToken)
  if (prodProject) return prodProject

  // Fall back to sandbox
  const sandboxProject = await tryLoadCodeAssist(SANDBOX_ENDPOINT, accessToken)
  if (sandboxProject) return sandboxProject

  return DEFAULT_PROJECT
}

async function tryLoadCodeAssist(endpoint: string, accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    })

    if (!res.ok) return null

    const data = (await res.json()) as CodeAssistResponse
    return data.projectId ?? data.project ?? null
  } catch {
    return null
  }
}
