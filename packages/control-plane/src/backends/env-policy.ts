/**
 * Environment policy for backend child processes.
 *
 * Secret handoff model:
 * - Control-plane process secrets remain private by default and are not inherited.
 * - Only a small OS/runtime allowlist is inherited from process.env.
 * - Task-scoped env vars are allowlisted and explicitly injected per task; this is
 *   the only supported channel for handing agent-specific secrets (for example model API keys).
 */
const INHERITED_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "NODE_PATH",
  "LANG",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
] as const

const TASK_ENV_ALLOWLIST = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "LLM_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "TRACEPARENT",
  "TRACESTATE",
  "BAGGAGE",
] as const

type InfoLogger = (message: string, details: { keys: string[] }) => void

const defaultInfoLogger: InfoLogger = (message, details) => {
  console.info(message, details)
}

function addAllowlistedKeys(
  source: Record<string, string | undefined>,
  target: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): void {
  for (const key of allowlist) {
    const value = source[key]
    if (typeof value === "string" && value.length > 0) {
      target[key] = value
    }
  }
}

export function buildBackendBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  addAllowlistedKeys(process.env, env, INHERITED_ENV_ALLOWLIST)
  return env
}

export function buildBackendSpawnEnv(
  taskEnvironment: Record<string, string>,
  logInfo: InfoLogger = defaultInfoLogger,
): NodeJS.ProcessEnv {
  const env = buildBackendBaseEnv()
  addAllowlistedKeys(taskEnvironment, env, TASK_ENV_ALLOWLIST)

  // Audit only env key names, never values.
  const injectedEnvKeys = Object.keys(env).sort()
  logInfo("[backend-env] injected env keys for backend process", { keys: injectedEnvKeys })

  return env
}
