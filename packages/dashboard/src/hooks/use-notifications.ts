"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { type Credential, getDashboardSummary, listCredentials, listJobs } from "@/lib/api-client"
import { tokenExpiry } from "@/lib/credential-health"

export interface NotificationItem {
  id: string
  icon: string
  label: string
  href: string
  severity: "error" | "warning" | "info"
}

export interface Notifications {
  items: NotificationItem[]
  count: number
  loading: boolean
}

const POLL_INTERVAL_MS = 30_000

function credentialSourceLabel(credential: Credential): string {
  if (credential.displayLabel && credential.displayLabel !== credential.provider) {
    return `${credential.provider} · ${credential.displayLabel}`
  }
  return credential.provider
}

function credentialWarningReason(credential: Credential, now: Date): string | null {
  if (
    credential.status === "expired" ||
    credential.status === "error" ||
    credential.status === "revoked"
  ) {
    return `status: ${credential.status}`
  }

  const expiry = tokenExpiry(credential, now)
  if (!expiry) return null
  if (expiry.severity === "warning" || expiry.severity === "danger") {
    return expiry.label.toLowerCase()
  }
  return null
}

export function buildCredentialWarningNotification(
  credentials: Credential[] | null | undefined,
  now: Date = new Date(),
): NotificationItem | null {
  const warned =
    credentials
      ?.map((credential) => {
        const reason = credentialWarningReason(credential, now)
        if (!reason) return null
        return {
          source: credentialSourceLabel(credential),
          reason,
        }
      })
      .filter((value): value is { source: string; reason: string } => value !== null) ?? []

  if (warned.length === 0) return null

  const [first] = warned
  if (!first) return null

  const label =
    warned.length === 1
      ? `Credential warning: ${first.source} (${first.reason})`
      : `Credential warnings: ${first.source} (${first.reason}) +${warned.length - 1} more`

  return {
    id: "expiring-creds",
    icon: "key_off",
    label,
    href: "/settings",
    severity: "warning",
  }
}

export function useNotifications(): Notifications {
  const [items, setItems] = useState<NotificationItem[]>([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  const poll = useCallback(async () => {
    try {
      const [summary, failedJobs, creds] = await Promise.all([
        getDashboardSummary().catch(() => null),
        listJobs({ status: "FAILED", limit: 1 }).catch(() => null),
        listCredentials().catch(() => null),
      ])

      if (!mountedRef.current) return

      const next: NotificationItem[] = []

      // Pending approvals
      const pending = summary?.pendingApprovals ?? 0
      if (pending > 0) {
        next.push({
          id: "pending-approvals",
          icon: "verified_user",
          label: `${pending} pending approval${pending > 1 ? "s" : ""}`,
          href: "/approvals",
          severity: "warning",
        })
      }

      // Failed jobs
      const failedCount = failedJobs?.pagination?.total ?? failedJobs?.jobs?.length ?? 0
      if (failedCount > 0) {
        next.push({
          id: "failed-jobs",
          icon: "error",
          label: `${failedCount} failed job${failedCount > 1 ? "s" : ""}`,
          href: "/jobs",
          severity: "error",
        })
      }

      // Credential health / expiration warnings
      const credentialWarning = buildCredentialWarningNotification(creds?.credentials)
      if (credentialWarning) {
        next.push(credentialWarning)
      }

      setItems(next)
    } catch {
      // Silently ignore — notifications are best-effort
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void poll()
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [poll])

  return { items, count: items.length, loading }
}
