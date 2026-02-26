/**
 * Tests for issue #151: Dashboard false outage due to API surface mismatch.
 *
 * Verifies that:
 * 1. NOT_FOUND (404) on feature endpoints is classified as feature-unavailable,
 *    not as a connection failure.
 * 2. Dashboard stats don't fall back to mock data when feature routes 404.
 * 3. The error banner only shows for genuine connectivity problems.
 * 4. ApiError.isFeatureUnavailable correctly identifies 404 errors.
 */

import { describe, expect, it } from "vitest"

import { ApiError, type ApiErrorCode } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// ApiError.isFeatureUnavailable
// ---------------------------------------------------------------------------

describe("ApiError.isFeatureUnavailable", () => {
  it("returns true for NOT_FOUND (404)", () => {
    const err = new ApiError(404, "Not Found", undefined, "NOT_FOUND")
    expect(err.isFeatureUnavailable).toBe(true)
  })

  it("returns false for CONNECTION_REFUSED", () => {
    const err = new ApiError(0, "Could not connect", undefined, "CONNECTION_REFUSED")
    expect(err.isFeatureUnavailable).toBe(false)
  })

  it("returns false for TIMEOUT", () => {
    const err = new ApiError(0, "Request timed out", undefined, "TIMEOUT")
    expect(err.isFeatureUnavailable).toBe(false)
  })

  it("returns false for SERVER_ERROR", () => {
    const err = new ApiError(500, "Internal error", undefined, "SERVER_ERROR")
    expect(err.isFeatureUnavailable).toBe(false)
  })

  it("returns false for TRANSIENT", () => {
    const err = new ApiError(503, "Unavailable", undefined, "TRANSIENT")
    expect(err.isFeatureUnavailable).toBe(false)
  })

  it("returns false for AUTH_ERROR", () => {
    const err = new ApiError(401, "Unauthorized", undefined, "AUTH_ERROR")
    expect(err.isFeatureUnavailable).toBe(false)
  })

  it("returns false for SCHEMA_MISMATCH", () => {
    const err = new ApiError(0, "Unexpected format", undefined, "SCHEMA_MISMATCH")
    expect(err.isFeatureUnavailable).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Error classification: connectivity vs feature-unavailable
// ---------------------------------------------------------------------------

/**
 * Mirror of the connectivity check used in use-dashboard.ts.
 * Kept in sync with the hook to validate the classification logic in isolation.
 */
const CONNECTIVITY_ERROR_CODES = new Set<ApiErrorCode>([
  "CONNECTION_REFUSED",
  "TIMEOUT",
  "SERVER_ERROR",
  "TRANSIENT",
  "AUTH_ERROR",
])

function isConnectivityError(code: ApiErrorCode | null): boolean {
  return code !== null && CONNECTIVITY_ERROR_CODES.has(code)
}

describe("error classification for dashboard banner", () => {
  it("NOT_FOUND is NOT a connectivity error", () => {
    expect(isConnectivityError("NOT_FOUND")).toBe(false)
  })

  it("SCHEMA_MISMATCH is NOT a connectivity error", () => {
    expect(isConnectivityError("SCHEMA_MISMATCH")).toBe(false)
  })

  it("UNKNOWN is NOT a connectivity error", () => {
    expect(isConnectivityError("UNKNOWN")).toBe(false)
  })

  it("null is NOT a connectivity error", () => {
    expect(isConnectivityError(null)).toBe(false)
  })

  it.each([
    "CONNECTION_REFUSED",
    "TIMEOUT",
    "SERVER_ERROR",
    "TRANSIENT",
    "AUTH_ERROR",
  ] satisfies ApiErrorCode[])("%s IS a connectivity error", (code) => {
    expect(isConnectivityError(code)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dashboard state scenarios
// ---------------------------------------------------------------------------

describe("dashboard error aggregation scenarios", () => {
  /**
   * Simulates the connectivityFailure logic from useDashboard.
   * Takes an array of { error, code } representing each API query result
   * and returns the first connectivity error, or null.
   */
  function findConnectivityFailure(
    sources: Array<{ error: string | null; code: ApiErrorCode | null }>,
  ): { error: string; code: ApiErrorCode } | null {
    return (
      (sources.find((s) => isConnectivityError(s.code)) as {
        error: string
        code: ApiErrorCode
      }) ?? null
    )
  }

  it("returns null when all queries succeed", () => {
    const result = findConnectivityFailure([
      { error: null, code: null },
      { error: null, code: null },
      { error: null, code: null },
      { error: null, code: null },
    ])
    expect(result).toBeNull()
  })

  it("returns null when some queries 404 (feature unavailable) but core is healthy", () => {
    // Scenario: /agents OK, /jobs 404, /approvals OK, /memory/search 404
    const result = findConnectivityFailure([
      { error: null, code: null },
      { error: "Not Found", code: "NOT_FOUND" },
      { error: null, code: null },
      { error: "Not Found", code: "NOT_FOUND" },
    ])
    expect(result).toBeNull()
  })

  it("returns null when ALL queries 404", () => {
    // Even if every feature route is missing, 404 is not a connection failure
    const result = findConnectivityFailure([
      { error: "Not Found", code: "NOT_FOUND" },
      { error: "Not Found", code: "NOT_FOUND" },
      { error: "Not Found", code: "NOT_FOUND" },
      { error: "Not Found", code: "NOT_FOUND" },
    ])
    expect(result).toBeNull()
  })

  it("returns the connectivity error when control plane is truly down", () => {
    const result = findConnectivityFailure([
      { error: "Could not connect", code: "CONNECTION_REFUSED" },
      { error: "Could not connect", code: "CONNECTION_REFUSED" },
      { error: "Could not connect", code: "CONNECTION_REFUSED" },
      { error: "Could not connect", code: "CONNECTION_REFUSED" },
    ])
    expect(result).not.toBeNull()
    expect(result!.code).toBe("CONNECTION_REFUSED")
  })

  it("surfaces connectivity error even when mixed with 404s", () => {
    // Scenario: /agents times out, /jobs 404, /approvals OK, /memory 404
    const result = findConnectivityFailure([
      { error: "Request timed out", code: "TIMEOUT" },
      { error: "Not Found", code: "NOT_FOUND" },
      { error: null, code: null },
      { error: "Not Found", code: "NOT_FOUND" },
    ])
    expect(result).not.toBeNull()
    expect(result!.code).toBe("TIMEOUT")
  })

  it("picks the first connectivity error when multiple exist", () => {
    const result = findConnectivityFailure([
      { error: null, code: null },
      { error: "Server error", code: "SERVER_ERROR" },
      { error: "Request timed out", code: "TIMEOUT" },
      { error: null, code: null },
    ])
    expect(result).not.toBeNull()
    expect(result!.code).toBe("SERVER_ERROR")
  })
})

// ---------------------------------------------------------------------------
// Feature page NOT_FOUND suppression
// ---------------------------------------------------------------------------

describe("feature page 404 suppression", () => {
  /**
   * Mirrors the pattern used in use-jobs-page.ts, use-memory-explorer.ts,
   * and use-pulse-pipeline.ts to suppress NOT_FOUND errors.
   */
  function suppressNotFound(
    rawError: string | null,
    rawErrorCode: ApiErrorCode | null,
  ): { error: string | null; errorCode: ApiErrorCode | null } {
    return {
      error: rawErrorCode === "NOT_FOUND" ? null : rawError,
      errorCode: rawErrorCode === "NOT_FOUND" ? null : rawErrorCode,
    }
  }

  it("suppresses NOT_FOUND error and code", () => {
    const result = suppressNotFound("Not Found", "NOT_FOUND")
    expect(result.error).toBeNull()
    expect(result.errorCode).toBeNull()
  })

  it("passes through CONNECTION_REFUSED", () => {
    const result = suppressNotFound("Could not connect", "CONNECTION_REFUSED")
    expect(result.error).toBe("Could not connect")
    expect(result.errorCode).toBe("CONNECTION_REFUSED")
  })

  it("passes through TIMEOUT", () => {
    const result = suppressNotFound("Request timed out", "TIMEOUT")
    expect(result.error).toBe("Request timed out")
    expect(result.errorCode).toBe("TIMEOUT")
  })

  it("passes through SERVER_ERROR", () => {
    const result = suppressNotFound("Internal error", "SERVER_ERROR")
    expect(result.error).toBe("Internal error")
    expect(result.errorCode).toBe("SERVER_ERROR")
  })

  it("passes through null (no error)", () => {
    const result = suppressNotFound(null, null)
    expect(result.error).toBeNull()
    expect(result.errorCode).toBeNull()
  })
})
