"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { getDashboardSummary, listCredentials, listJobs } from "@/lib/api-client"

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
const CREDENTIAL_EXPIRY_WARN_DAYS = 7

function isExpiringSoon(tokenExpiresAt: string | null | undefined): boolean {
  if (!tokenExpiresAt) return false
  const expiresMs = new Date(tokenExpiresAt).getTime()
  const warnMs = Date.now() + CREDENTIAL_EXPIRY_WARN_DAYS * 86_400_000
  return expiresMs > 0 && expiresMs < warnMs
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

      // Expiring credentials
      const expiring = creds?.credentials?.filter((c) => isExpiringSoon(c.tokenExpiresAt)) ?? []
      if (expiring.length > 0) {
        next.push({
          id: "expiring-creds",
          icon: "key_off",
          label: `${expiring.length} credential${expiring.length > 1 ? "s" : ""} expiring soon`,
          href: "/settings",
          severity: "warning",
        })
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
