import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * CI guardrail: ensure all API client endpoints pass a schema to apiFetch().
 *
 * Every call to apiFetch() must include a `schema:` property so that
 * response payloads are validated at the data boundary. Unvalidated
 * apiFetch() calls silently trust untrusted server data.
 */

const API_CLIENT_PATH = path.resolve(__dirname, "../lib/api-client.ts")

/** Extract apiFetch() calls handling nested parens / template literals. */
function extractApiFetchCalls(src: string): string[] {
  const calls: string[] = []
  const marker = "apiFetch("
  let idx = 0

  while ((idx = src.indexOf(marker, idx)) !== -1) {
    const start = idx
    let depth = 0
    let i = idx + marker.length - 1 // position at the '('

    for (; i < src.length; i++) {
      if (src[i] === "(") depth++
      else if (src[i] === ")") {
        depth--
        if (depth === 0) break
      }
    }

    calls.push(src.slice(start, i + 1))
    idx = i + 1
  }

  return calls
}

describe("API boundary validation", () => {
  it("all apiFetch() calls in exported endpoint functions must include a schema parameter", () => {
    const content = readFileSync(API_CLIENT_PATH, "utf-8")
    const allCalls = extractApiFetchCalls(content)

    // Exclude the internal apiFetch function definition itself (the one with `schema ?`)
    const endpointCalls = allCalls.filter(
      (call) => !call.includes("schema ?") && !call.includes("schema?"),
    )

    const unvalidated = endpointCalls.filter((call) => !call.includes("schema:"))

    expect(
      unvalidated,
      `Found apiFetch() calls without schema validation:\n${unvalidated.join("\n---\n")}`,
    ).toEqual([])
  })
})
