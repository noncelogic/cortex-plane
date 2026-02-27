"use client"

import { usePathname } from "next/navigation"
import { useMemo } from "react"

import { useAuth } from "@/components/auth-provider"
import { resolveAuthGuard } from "@/lib/auth-guard"

export function useAuthGuard() {
  const pathname = usePathname()
  const { authStatus, authError, refreshSession } = useAuth()

  const guardState = useMemo(
    () => resolveAuthGuard(pathname, authStatus),
    [pathname, authStatus],
  )

  return {
    pathname,
    authStatus,
    authError,
    refreshSession,
    ...guardState,
  }
}
