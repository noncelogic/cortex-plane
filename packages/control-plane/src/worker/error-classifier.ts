/**
 * Error classification for all external calls. Determines retry strategy
 * at both the Graphile Worker level and the application level.
 *
 * Classification categories:
 * - TRANSIENT: retry with exponential backoff (HTTP 429, 502, 503, ECONNRESET)
 * - PERMANENT: fail immediately, no retry (HTTP 400, 401, 404, schema validation)
 * - TIMEOUT: retry with increased timeout (execution exceeded duration)
 * - RESOURCE: retry after cooldown (OOM, disk full, rate limit)
 * - UNKNOWN: retry once, then fail (unclassified errors)
 */

export type ErrorCategory = "TRANSIENT" | "PERMANENT" | "TIMEOUT" | "RESOURCE" | "UNKNOWN"

export interface ErrorClassification {
  category: ErrorCategory
  retryable: boolean
  message: string
}

const TRANSIENT_HTTP_CODES = new Set([429, 502, 503, 529])

const PERMANENT_HTTP_CODES = new Set([400, 401, 403, 404, 405, 409, 422])

const TRANSIENT_NODE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
])

const RESOURCE_NODE_CODES = new Set(["ENOMEM", "ENOSPC", "EMFILE", "ENFILE"])

function classifyHttpStatus(status: number): ErrorClassification {
  if (status >= 200 && status < 300) {
    return { category: "TRANSIENT", retryable: false, message: `HTTP ${status} (success)` }
  }
  if (TRANSIENT_HTTP_CODES.has(status)) {
    return { category: "TRANSIENT", retryable: true, message: `HTTP ${status} (transient)` }
  }
  if (PERMANENT_HTTP_CODES.has(status)) {
    return { category: "PERMANENT", retryable: false, message: `HTTP ${status} (permanent)` }
  }
  if (status === 408 || status === 504) {
    return { category: "TIMEOUT", retryable: true, message: `HTTP ${status} (timeout)` }
  }
  if (status >= 500) {
    return { category: "TRANSIENT", retryable: true, message: `HTTP ${status} (server error)` }
  }
  return { category: "PERMANENT", retryable: false, message: `HTTP ${status} (client error)` }
}

function classifyNodeError(code: string): ErrorClassification {
  if (TRANSIENT_NODE_CODES.has(code)) {
    return { category: "TRANSIENT", retryable: true, message: `Node error: ${code}` }
  }
  if (RESOURCE_NODE_CODES.has(code)) {
    return { category: "RESOURCE", retryable: true, message: `Resource error: ${code}` }
  }
  if (code === "ENOTFOUND" || code === "EACCES" || code === "ENOENT") {
    return { category: "PERMANENT", retryable: false, message: `Node error: ${code}` }
  }
  return { category: "UNKNOWN", retryable: true, message: `Unknown node error: ${code}` }
}

/**
 * Classify an error from any source (HTTP, Node.js, LLM SDK, tool).
 * Returns an ErrorClassification that determines retry behavior.
 */
export function classifyError(error: unknown): ErrorClassification {
  if (!(error instanceof Error)) {
    return { category: "UNKNOWN", retryable: true, message: String(error) }
  }

  // AbortError — shutdown or user-initiated timeout
  if (error.name === "AbortError") {
    return { category: "TIMEOUT", retryable: true, message: "Operation aborted" }
  }

  // HTTP errors with status codes
  const errorRecord = error as unknown as Record<string, unknown>
  if ("status" in error && typeof errorRecord.status === "number") {
    return classifyHttpStatus(errorRecord.status)
  }

  // Anthropic / OpenAI SDK errors by constructor name
  const ctorName = error.constructor.name
  if (ctorName === "RateLimitError") {
    return { category: "RESOURCE", retryable: true, message: "Rate limit exceeded" }
  }
  if (ctorName === "APIConnectionError") {
    return { category: "TRANSIENT", retryable: true, message: "API connection error" }
  }
  if (ctorName === "AuthenticationError") {
    return { category: "PERMANENT", retryable: false, message: "Authentication failed" }
  }
  if (ctorName === "BadRequestError") {
    return { category: "PERMANENT", retryable: false, message: "Bad request" }
  }
  if (ctorName === "InternalServerError") {
    return { category: "TRANSIENT", retryable: true, message: "Internal server error" }
  }
  if (ctorName === "OverloadedError") {
    return { category: "RESOURCE", retryable: true, message: "Service overloaded" }
  }

  // Node.js system errors with error codes
  if ("code" in error && typeof errorRecord.code === "string") {
    return classifyNodeError(errorRecord.code)
  }

  // Timeout patterns in error messages
  if (error.message.toLowerCase().includes("timeout")) {
    return { category: "TIMEOUT", retryable: true, message: error.message }
  }

  // OOM patterns
  if (
    error.message.includes("out of memory") ||
    error.message.includes("ENOMEM") ||
    error.message.includes("heap out of memory")
  ) {
    return { category: "RESOURCE", retryable: true, message: error.message }
  }

  return { category: "UNKNOWN", retryable: true, message: error.message }
}
