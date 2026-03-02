/**
 * Built-in web_search tool — performs web searches via HTTP.
 *
 * Delegates to a configurable search endpoint (defaults to Brave Search API).
 * Requires SEARCH_API_KEY and optionally SEARCH_API_URL in the environment.
 */

import type { ToolDefinition } from "../tool-executor.js"

export interface WebSearchConfig {
  /** Base URL of the search API. Defaults to Brave Search. */
  apiUrl?: string
  /** API key for authentication. */
  apiKey?: string
  /** Maximum number of results to return. */
  maxResults?: number
}

const DEFAULT_API_URL = "https://api.search.brave.com/res/v1/web/search"
const DEFAULT_MAX_RESULTS = 5

export function createWebSearchTool(config?: WebSearchConfig): ToolDefinition {
  const apiUrl = config?.apiUrl ?? process.env.SEARCH_API_URL ?? DEFAULT_API_URL
  const apiKey = config?.apiKey ?? process.env.SEARCH_API_KEY ?? ""
  const maxResults = config?.maxResults ?? DEFAULT_MAX_RESULTS

  return {
    name: "web_search",
    description:
      "Search the web for information. Returns a list of relevant results with titles, URLs, and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        count: {
          type: "number",
          description: "Number of results to return (default 5, max 20)",
        },
      },
      required: ["query"],
    },
    execute: async (input) => {
      const query = typeof input.query === "string" ? input.query : String(input.query)
      const count = Math.min(typeof input.count === "number" ? input.count : maxResults, 20)

      if (!apiKey) {
        return JSON.stringify({
          error: "web_search is not configured: missing SEARCH_API_KEY",
        })
      }

      const url = new URL(apiUrl)
      url.searchParams.set("q", query)
      url.searchParams.set("count", String(count))

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        return JSON.stringify({
          error: `Search API returned ${response.status}: ${response.statusText}`,
        })
      }

      const data = (await response.json()) as Record<string, unknown>

      // Extract web results from Brave Search format
      const webResults = (data.web as Record<string, unknown> | undefined)?.results
      if (!Array.isArray(webResults)) {
        return JSON.stringify({ results: [], query })
      }

      const results = webResults.slice(0, count).map((r: Record<string, unknown>) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        description: r.description ?? "",
      }))

      return JSON.stringify({ results, query })
    },
  }
}
