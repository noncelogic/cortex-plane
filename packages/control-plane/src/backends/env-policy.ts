/**
 * Environment policy for backend child processes.
 *
 * Secret handoff model:
 * - Control-plane process secrets remain private by default and are not inherited.
 * - Only a small OS/runtime allowlist is inherited from process.env.
 * - Task-scoped env vars are explicitly injected per task and are the only supported
 *   channel for handing agent-specific secrets (for example model API keys).
 */
const BACKEND_ENV_ALLOWLIST = ["PATH", "HOME", "NODE_PATH", "LANG", "TERM"] as const

export function buildBackendSpawnEnv(taskEnvironment: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const key of BACKEND_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (typeof value === "string" && value.length > 0) {
      env[key] = value
    }
  }

  // Task context env is an explicit handoff from scheduler to backend process.
  for (const [key, value] of Object.entries(taskEnvironment)) {
    env[key] = value
  }

  // Audit only env key names, never values.
  const injectedEnvKeys = Object.keys(env).sort()
  console.debug("[backend-env] injected env keys for backend process", { keys: injectedEnvKeys })

  return env
}
