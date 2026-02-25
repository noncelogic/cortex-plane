"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/approvals", label: "Approvals" },
  { href: "/jobs", label: "Jobs" },
  { href: "/memory", label: "Memory" },
  { href: "/pulse", label: "AI Pulse" },
] as const

export function NavShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname()

  return (
    <div className="flex min-h-screen">
      {/* Sidebar — hidden on mobile, shown on lg+ */}
      <nav className="hidden w-56 shrink-0 border-r border-gray-800 bg-gray-900 p-4 lg:block">
        <Link href="/" className="mb-8 block text-lg font-bold text-cortex-400">
          Cortex Plane
        </Link>
        <ul className="space-y-1">
          {navItems.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                className={`block rounded-md px-3 py-2 text-sm ${
                  pathname === href
                    ? "bg-cortex-900/50 text-cortex-300 font-medium"
                    : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                }`}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {/* Main content area */}
      <div className="flex-1 overflow-auto">
        {/* Mobile top bar */}
        <header className="flex items-center justify-between border-b border-gray-800 px-4 py-3 lg:hidden">
          <Link href="/" className="text-lg font-bold text-cortex-400">
            Cortex Plane
          </Link>
          {/* TODO: mobile menu toggle */}
        </header>

        <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">{children}</div>
      </div>
    </div>
  )
}
