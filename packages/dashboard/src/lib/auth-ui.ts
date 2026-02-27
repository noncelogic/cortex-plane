import type { SessionUser } from "@/components/auth-provider"

const PUBLIC_AUTH_PATHS = ["/login", "/auth/complete"] as const

export function isPublicAuthPath(pathname: string): boolean {
  return PUBLIC_AUTH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

export function getUserInitials(user: SessionUser | null): string {
  const source = user?.displayName?.trim() || user?.email?.trim() || ""
  if (!source) return "?"

  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase()
  }

  return parts
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase()
}

export function resolveAuthGuard(
  pathname: string,
  isLoading: boolean,
  isAuthenticated: boolean,
): {
  shouldHideChrome: boolean
  shouldShowLoading: boolean
  shouldRedirectToLogin: boolean
} {
  const shouldHideChrome = isPublicAuthPath(pathname)
  if (shouldHideChrome) {
    return {
      shouldHideChrome: true,
      shouldShowLoading: false,
      shouldRedirectToLogin: false,
    }
  }

  if (isLoading) {
    return {
      shouldHideChrome: false,
      shouldShowLoading: true,
      shouldRedirectToLogin: false,
    }
  }

  return {
    shouldHideChrome: false,
    shouldShowLoading: false,
    shouldRedirectToLogin: !isAuthenticated,
  }
}
