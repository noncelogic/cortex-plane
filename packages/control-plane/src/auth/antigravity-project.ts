/**
 * Antigravity Project Discovery
 *
 * After Google Antigravity OAuth, discovers the user's Google Cloud project
 * by calling the cloudcode-pa API. Tries production endpoint first, then
 * falls back to sandbox, then returns a default.
 */

const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
const SANDBOX_ENDPOINT =
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist"
const DEFAULT_PROJECT = "rising-fact-p41fc"
const FETCH_TIMEOUT_MS = 5000

const CLIENT_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
} as const

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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "google-api-nodejs-client/9.15.1",
        "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
        "Client-Metadata": JSON.stringify(CLIENT_METADATA),
      },
      body: JSON.stringify({ metadata: CLIENT_METADATA }),
    })
    clearTimeout(timeout)

    if (!res.ok) return null

    const data = (await res.json()) as Record<string, unknown>
    // Handle both string and object formats for cloudaicompanionProject
    if (typeof data.cloudaicompanionProject === "string" && data.cloudaicompanionProject) {
      return data.cloudaicompanionProject
    }
    if (data.cloudaicompanionProject && typeof data.cloudaicompanionProject === "object") {
      const id = (data.cloudaicompanionProject as { id?: unknown }).id
      if (typeof id === "string" && id) return id
    }
    return null
  } catch {
    clearTimeout(timeout)
    return null
  }
}
