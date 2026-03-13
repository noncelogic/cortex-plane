/**
 * Pure utility helpers for credential health display.
 *
 * These are extracted from the settings page so they can be unit-tested
 * without React rendering.
 */

import type { Credential } from "./api-client"

// ---------------------------------------------------------------------------
// Token expiry helpers
// ---------------------------------------------------------------------------

export interface ExpiryInfo {
  /** Human-readable label, e.g. "Expires in 2h 15m", "Expired 3d ago", or "Auto-renewing" */
  label: string
  /** Severity for styling: "ok" (>24h or auto-renewing), "warning" (<24h), "danger" (expired) */
  severity: "ok" | "warning" | "danger"
}

/**
 * Compute a human-readable expiry summary for a credential.
 * Returns null for credentials without a tokenExpiresAt timestamp.
 *
 * Active OAuth credentials are auto-refreshed server-side, so we show
 * "Auto-renewing" instead of a raw countdown that goes stale immediately.
 */
export function tokenExpiry(cred: Credential, now: Date = new Date()): ExpiryInfo | null {
  if (!cred.tokenExpiresAt) return null

  // Active OAuth credentials are refreshed automatically by the server.
  // Showing a countdown is misleading because the token will be renewed
  // before it actually expires.
  if (cred.credentialType === "oauth" && cred.status === "active") {
    return { label: "Auto-renewing", severity: "ok" }
  }

  const expiresAt = new Date(cred.tokenExpiresAt)
  const diffMs = expiresAt.getTime() - now.getTime()

  if (diffMs <= 0) {
    // Already expired — show how long ago
    const ago = formatDuration(Math.abs(diffMs))
    return { label: `Expired ${ago} ago`, severity: "danger" }
  }

  const label = `Expires in ${formatDuration(diffMs)}`
  const severity = diffMs < 24 * 60 * 60 * 1000 ? "warning" : "ok"
  return { label, severity }
}

// ---------------------------------------------------------------------------
// Error summary
// ---------------------------------------------------------------------------

export interface ErrorInfo {
  /** Short summary, e.g. "3 consecutive failures" or the lastError message */
  label: string
  /** The raw error message, if any */
  message: string | null
}

/**
 * Build an error summary for display. Returns null when there is no error state.
 */
export function errorSummary(cred: Credential): ErrorInfo | null {
  if (cred.status !== "error" && cred.status !== "expired" && cred.status !== "revoked") {
    // Even for active credentials, show if there are recent errors
    if (!cred.errorCount || cred.errorCount === 0) return null
  }

  const count = cred.errorCount ?? 0
  const message = cred.lastError ?? null

  if (count === 0 && !message) {
    // Status is error/expired/revoked but no details available
    return { label: `Status: ${cred.status}`, message: null }
  }

  const label =
    count > 0 ? `${count} consecutive failure${count === 1 ? "" : "s"}` : (message ?? "Error")

  return { label, message }
}

// ---------------------------------------------------------------------------
// Refresh status
// ---------------------------------------------------------------------------

/**
 * Format the last-refresh timestamp for display. Returns null when unavailable.
 */
export function refreshStatus(cred: Credential): string | null {
  if (!cred.lastRefreshAt) return null
  return `Last refreshed: ${new Date(cred.lastRefreshAt).toLocaleString()}`
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return "<1m"
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}
