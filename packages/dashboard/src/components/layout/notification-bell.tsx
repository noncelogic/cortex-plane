"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"

import { useNotifications, type NotificationItem } from "@/hooks/use-notifications"

/* ── Icon helper (mirrors nav-shell) ───────────────── */
function Icon({ name, className }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined text-[20px] ${className ?? ""}`}>{name}</span>
}

const severityColor: Record<NotificationItem["severity"], string> = {
  error: "text-red-400",
  warning: "text-amber-400",
  info: "text-text-muted",
}

export function NotificationBell() {
  const { items, count } = useNotifications()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex size-8 items-center justify-center rounded-lg text-text-muted hover:bg-secondary hover:text-primary transition-colors"
        aria-label={`Notifications${count > 0 ? ` (${count})` : ""}`}
      >
        <Icon name="notifications" />

        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-72 rounded-xl border border-surface-border bg-surface-light shadow-lg">
          <div className="border-b border-surface-border px-4 py-2.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Notifications
            </span>
          </div>

          {items.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-text-muted">All clear</div>
          ) : (
            <ul className="max-h-64 overflow-y-auto py-1">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-3 px-4 py-2.5 text-sm text-text-main hover:bg-secondary transition-colors"
                  >
                    <Icon name={item.icon} className={severityColor[item.severity]} />
                    <span>{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
