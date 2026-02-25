"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"

import { useTheme } from "@/components/theme-provider"

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
      className={`hidden lg:flex flex-col shrink-0 border-r border-slate-200 dark:border-slate-800 bg-surface-light dark:bg-bg-dark transition-all duration-200 ${
        collapsed ? "w-[68px]" : "w-64"
      }`}
    >
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 py-6">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary">
          <span className="text-sm font-bold text-primary-content">CP</span>
        </div>
        {!collapsed && (
          <span className="font-display text-sm font-bold tracking-tight text-text-main dark:text-white">
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
                  : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 border border-transparent"
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
        className="mx-3 mb-4 flex items-center justify-center rounded-lg p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <NavIcon name={collapsed ? "chevron_right" : "chevron_left"} />
      </button>
    </nav>
  )
}

/* ── Top nav header ──────────────────────────────────── */
function TopNav() {
  const { theme, toggle } = useTheme()

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-surface-light/80 dark:bg-bg-dark/80 backdrop-blur-md px-4 lg:px-8">
      {/* Left: mobile brand */}
      <div className="flex items-center gap-3 lg:hidden">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary">
          <span className="text-xs font-bold text-primary-content">CP</span>
        </div>
        <span className="font-display text-sm font-bold tracking-tight text-text-main dark:text-white">
          Cortex Plane
        </span>
      </div>

      {/* Left: desktop breadcrumb placeholder */}
      <div className="hidden lg:flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-success animate-pulse" />
          <span className="text-[10px] text-slate-500 font-medium uppercase">System Online</span>
        </span>
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-2">
        {/* Theme toggle */}
        <button
          type="button"
          onClick={toggle}
          className="flex size-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-primary transition-colors"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          <NavIcon name={theme === "dark" ? "light_mode" : "dark_mode"} />
        </button>

        {/* Notifications placeholder */}
        <button
          type="button"
          className="flex size-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-primary transition-colors"
          aria-label="Notifications"
        >
          <NavIcon name="notifications" />
        </button>

        {/* User menu placeholder */}
        <div className="size-8 rounded-full bg-slate-200 dark:bg-slate-700" />
      </div>
    </header>
  )
}

/* ── Bottom tabs (mobile) ────────────────────────────── */
function BottomTabs() {
  const pathname = usePathname()

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 flex items-center justify-between border-t border-slate-200 dark:border-slate-800 bg-surface-light/95 dark:bg-bg-dark/95 backdrop-blur-md px-6 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:hidden">
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
  const [collapsed, setCollapsed] = useState(false)

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
