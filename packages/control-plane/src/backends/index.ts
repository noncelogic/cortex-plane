/**
 * Execution Backend Exports
 *
 * Re-exports the Claude Code backend and provides a factory function
 * for creating backends by ID.
 */

import type { ExecutionBackend } from "@cortex/shared"

import { ClaudeCodeBackend } from "./claude-code.js"

export { ClaudeCodeBackend } from "./claude-code.js"

/** Default concurrency limits per backend type. */
export const DEFAULT_CONCURRENCY: Record<string, number> = {
  "claude-code": 1,
  codex: 5,
  aider: 1,
}

/** Create a backend instance by ID. */
export function createBackend(backendId: string): ExecutionBackend {
  switch (backendId) {
    case "claude-code":
      return new ClaudeCodeBackend()
    default:
      throw new Error(`Unknown backend: '${backendId}'`)
  }
}
