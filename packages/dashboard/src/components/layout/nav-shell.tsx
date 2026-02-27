"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"

import { UserMenu } from "@/components/layout/user-menu"
import { useAuthGuard } from "@/hooks/use-auth-guard"

/* ── Navigation items ────────────────────────────────── */
const navItems = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/agents", label: "Agents", icon: "smart_toy" },
  { href: "/approvals", label: "Approvals", icon: "verified_user" },
  { href: "/jobs", label: "Jobs", icon: "list_alt" },
  { href: "/memory", label: "Memory", icon: "memory" },
  { href: "/pulse", label: "Pulse", icon: "hub" },
] as const

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(href + "/")
}

/* ── Icon helper ─────────────────────────────────────── */
function NavIcon({
  name,
  filled,
  className,
}: {
  name: string
  filled?: boolean
  className?: string
}) {
  return (
    <span
      className={`material-symbols-outlined text-[20px] ${className ?? ""}`}
      style={filled ? { fontVariationSettings: "'FILL' 1" } : undefined}
    >
      {name}
    </span>
  )
}

/* ── Sidebar (desktop) ───────────────────────────────── */
function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = usePathname()

  return (
    <nav
      className={`hidden lg:flex flex-col shrink-0 border-r border-surface-border bg-surface-light transition-all duration-200 ${
        collapsed ? "w-[68px]" : "w-64"
      }`}
    >
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 py-6">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary">
          <span className="text-sm font-bold text-primary-content">CP</span>
        </div>
        {!collapsed && (
          <span className="font-display text-sm font-bold tracking-tight text-text-main">
            Cortex Plane
          </span>
        )}
      </div>

      {/* Nav links */}
      <div className="flex-1 space-y-1 px-3">
        {navItems.map(({ href, label, icon }) => {
          const active = isActive(pathname, href)
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-primary/10 text-primary border border-primary/20"
                  : "text-text-muted hover:bg-secondary border border-transparent"
              }`}
            >
              <NavIcon name={icon} filled={active} />
              {!collapsed && <span>{label}</span>}
            </Link>
          )
        })}
      </div>

      {/* Collapse toggle */}
      <button
        type="button"
        onClick={onToggle}
        className="mx-3 mb-4 flex items-center justify-center rounded-lg p-2 text-text-muted hover:bg-secondary transition-colors"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <NavIcon name={collapsed ? "chevron_right" : "chevron_left"} />
      </button>
    </nav>
  )
}

/* ── Top nav header ──────────────────────────────────── */
function TopNav() {
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-surface-border bg-surface-light/80 backdrop-blur-md px-4 lg:px-8">
      {/* Left: mobile brand */}
      <div className="flex items-center gap-3 lg:hidden">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary">
          <span className="text-xs font-bold text-primary-content">CP</span>
        </div>
        <span className="font-display text-sm font-bold tracking-tight text-text-main">
          Cortex Plane
        </span>
      </div>

      {/* Left: desktop breadcrumb placeholder */}
      <div className="hidden lg:flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-success animate-pulse" />
          <span className="text-[10px] text-text-muted font-medium uppercase">System Online</span>
        </span>
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-2">
        {/* Notifications placeholder */}
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-lg text-text-muted hover:bg-secondary hover:text-primary transition-colors"
          aria-label="Notifications"
        >
          <NavIcon name="notifications" />
        </button>

        {/* User menu with theme toggle */}
        <UserMenu />
      </div>
    </header>
  )
}

/* ── Bottom tabs (mobile) ────────────────────────────── */
function BottomTabs() {
  const pathname = usePathname()

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 flex items-center justify-between border-t border-surface-border bg-surface-light/95 backdrop-blur-md px-6 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:hidden">
      {navItems.map(({ href, label, icon }) => {
        const active = isActive(pathname, href)
        return (
          <Link
            key={href}
            href={href}
            className={`group flex flex-col items-center gap-1 ${
              active ? "text-primary" : "text-text-muted hover:text-primary"
            } transition-colors`}
          >
            <NavIcon
              name={icon}
              filled={active}
              className="group-hover:scale-110 transition-transform"
            />
            <span className="text-[10px] font-bold">{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

/* ── Shell ────────────────────────────────────────────── */
export function NavShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)
  const guardState = useAuthGuard()

  useEffect(() => {
    if (guardState.shouldRedirectToLogin) {
      router.replace("/login")
    }
  }, [guardState.shouldRedirectToLogin, router])

  // Auth-related pages render without sidebar/nav
  if (guardState.shouldHideChrome) {
    return <>{children}</>
  }

  if (guardState.shouldShowLoading || guardState.shouldRedirectToLogin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-dark">
        <div className="size-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  if (guardState.shouldShowUnverified) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-dark px-4">
        <div className="max-w-md rounded-xl border border-surface-border bg-surface-light p-6 text-center">
          <p className="text-sm font-semibold text-text-main">Unable to verify your session</p>
          <p className="mt-2 text-sm text-text-muted">
            The control-plane session endpoint is temporarily unavailable. Retry when connectivity
            stabilizes.
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void guardState.refreshSession()}
              className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary transition-colors hover:bg-primary/20"
            >
              Retry session check
            </button>
            <button
              type="button"
              onClick={() => router.replace("/login")}
              className="rounded-lg border border-surface-border bg-surface-dark px-4 py-2 text-sm font-semibold text-text-main transition-colors hover:bg-secondary"
            >
              Go to sign in
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />

      <div className="flex flex-1 flex-col overflow-hidden">
        <TopNav />

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-4 pb-24 sm:p-6 lg:p-8 lg:pb-8">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>

      <BottomTabs />
    </div>
  )
}
