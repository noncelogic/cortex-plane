import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

/**
 * Next.js Edge Middleware — lightweight cookie-presence check for route protection.
 *
 * When the `cortex_session` cookie is missing, redirects to /login for any
 * protected route. This prevents flashing the dashboard in an unauthenticated
 * state before the client-side AuthProvider can check the session.
 *
 * NOTE: This only checks for cookie *presence*, not validity. Full session
 * validation still happens server-side via the control plane's requireAuth
 * middleware. A stale/expired cookie will be caught by the AuthProvider and
 * the user will see the appropriate error state.
 */

/** Routes that do NOT require authentication. */
const PUBLIC_PATHS = ["/login", "/auth/complete", "/api/"]

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p))
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Skip public paths and static assets
  if (isPublicPath(pathname)) {
    return NextResponse.next()
  }

  const hasSession = request.cookies.has("cortex_session")
  if (!hasSession) {
    const loginUrl = new URL("/login", request.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt
     */
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
}
