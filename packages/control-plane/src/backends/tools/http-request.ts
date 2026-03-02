/**
 * Built-in http_request tool — makes arbitrary HTTP requests.
 *
 * Supports GET, POST, PUT, PATCH, DELETE methods with configurable
 * headers, body, and timeout. Useful for calling external APIs.
 */

import type { ToolDefinition } from "../tool-executor.js"

export interface HttpRequestConfig {
  /** Maximum allowed timeout per request (ms). */
  maxTimeoutMs?: number
  /** Maximum response body size (bytes). */
  maxResponseBytes?: number
  /** Optional URL allowlist. If set, only these URL prefixes are permitted. */
  allowedUrlPrefixes?: string[]
}

const DEFAULT_MAX_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576 // 1 MB
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])

export function createHttpRequestTool(config?: HttpRequestConfig): ToolDefinition {
  const maxTimeoutMs = config?.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
  const maxResponseBytes = config?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const allowedUrlPrefixes = config?.allowedUrlPrefixes

  return {
    name: "http_request",
    description:
      "Make an HTTP request to an external URL. Supports GET, POST, PUT, PATCH, DELETE methods.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to request" },
        method: {
          type: "string",
          description: "HTTP method (GET, POST, PUT, PATCH, DELETE). Defaults to GET.",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        },
        headers: {
          type: "object",
          description: "Request headers as key-value pairs",
        },
        body: {
          type: "string",
          description: "Request body (for POST/PUT/PATCH). Sent as-is.",
        },
        timeout_ms: {
          type: "number",
          description: "Request timeout in milliseconds (default 30000)",
        },
      },
      required: ["url"],
    },
    execute: async (input) => {
      const url = typeof input.url === "string" ? input.url : String(input.url)
      const method = typeof input.method === "string" ? input.method.toUpperCase() : "GET"
      const headers =
        typeof input.headers === "object" && input.headers !== null
          ? (input.headers as Record<string, string>)
          : {}
      const body = typeof input.body === "string" ? input.body : undefined
      const timeoutMs = Math.min(
        typeof input.timeout_ms === "number" ? input.timeout_ms : maxTimeoutMs,
        maxTimeoutMs,
      )

      // Validate method
      if (!ALLOWED_METHODS.has(method)) {
        return JSON.stringify({ error: `Unsupported HTTP method: ${method}` })
      }

      // Validate URL
      let parsedUrl: URL
      try {
        parsedUrl = new URL(url)
      } catch {
        return JSON.stringify({ error: `Invalid URL: ${url}` })
      }

      // Block private/internal addresses
      const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, "")
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname === "0.0.0.0" ||
        hostname.endsWith(".internal")
      ) {
        return JSON.stringify({
          error: "Requests to localhost and internal addresses are not allowed",
        })
      }

      // Check URL allowlist
      if (allowedUrlPrefixes && allowedUrlPrefixes.length > 0) {
        const allowed = allowedUrlPrefixes.some((prefix) => url.startsWith(prefix))
        if (!allowed) {
          return JSON.stringify({ error: "URL is not in the allowed list" })
        }
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body && method !== "GET" ? body : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })

      // Read response with size limit
      const contentLength = response.headers.get("content-length")
      if (contentLength && parseInt(contentLength, 10) > maxResponseBytes) {
        return JSON.stringify({
          error: `Response too large: ${contentLength} bytes (max ${maxResponseBytes})`,
          status: response.status,
        })
      }

      const responseBody = await response.text()
      if (responseBody.length > maxResponseBytes) {
        return JSON.stringify({
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: responseBody.slice(0, maxResponseBytes),
          truncated: true,
        })
      }

      return JSON.stringify({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      })
    },
  }
}
