import type { AuthStatus } from "@/components/auth-provider"

const PUBLIC_AUTH_PATHS = ["/login", "/auth/complete"] as const

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1)
  }
  return pathname
}

export function isPublicAuthPath(pathname: string): boolean {
  const normalizedPath = normalizePath(pathname)
  return PUBLIC_AUTH_PATHS.some((path) => normalizedPath === path)
}

export interface RouteAuthGuardState {
  shouldHideChrome: boolean
  shouldShowLoading: boolean
  shouldShowUnverified: boolean
  shouldRedirectToLogin: boolean
  shouldRedirectToDashboard: boolean
}

export function resolveAuthGuard(pathname: string, authStatus: AuthStatus): RouteAuthGuardState {
  if (isPublicAuthPath(pathname)) {
    return {
      shouldHideChrome: true,
      shouldShowLoading: authStatus === "loading",
      shouldShowUnverified: false,
      shouldRedirectToLogin: false,
      shouldRedirectToDashboard: authStatus === "authenticated",
    }
  }

  if (authStatus === "loading") {
    return {
      shouldHideChrome: false,
      shouldShowLoading: true,
      shouldShowUnverified: false,
      shouldRedirectToLogin: false,
      shouldRedirectToDashboard: false,
    }
  }

  if (authStatus === "unverified") {
    return {
      shouldHideChrome: false,
      shouldShowLoading: false,
      shouldShowUnverified: true,
      shouldRedirectToLogin: false,
      shouldRedirectToDashboard: false,
    }
  }

  return {
    shouldHideChrome: false,
    shouldShowLoading: false,
    shouldShowUnverified: false,
    shouldRedirectToLogin: authStatus === "unauthenticated",
    shouldRedirectToDashboard: false,
  }
}
