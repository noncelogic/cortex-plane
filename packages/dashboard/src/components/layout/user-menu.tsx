"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { useTheme } from "@/components/theme-provider"

export function UserMenu() {
  const { theme, toggle } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") close()
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKey)
    return () => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKey)
    }
  }, [open, close])

  return (
    <div ref={ref} className="relative">
      {/* Trigger — avatar circle */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-content transition-shadow hover:ring-2 hover:ring-primary/30"
        aria-label="User menu"
        aria-expanded={open}
      >
        OP
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-56 origin-top-right rounded-xl border border-surface-border bg-surface-light p-1 shadow-lg animate-in fade-in">
          {/* Identity */}
          <div className="px-3 py-2.5">
            <p className="text-sm font-semibold text-text-main">Operator</p>
            <span className="mt-0.5 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
              Admin
            </span>
          </div>

          <div className="mx-2 border-t border-surface-border" />

          {/* Theme toggle row */}
          <button
            type="button"
            onClick={toggle}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-main transition-colors hover:bg-secondary"
          >
            <span className="material-symbols-outlined text-[18px] text-text-muted">
              {theme === "dark" ? "light_mode" : "dark_mode"}
            </span>
            <span className="flex-1 text-left">
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </span>
            {/* Toggle switch visual */}
            <span
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                theme === "dark" ? "bg-primary" : "bg-text-muted/30"
              }`}
            >
              <span
                className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform ${
                  theme === "dark" ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </span>
          </button>

          {/* Settings (placeholder) */}
          <button
            type="button"
            disabled
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-muted opacity-50 cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[18px]">settings</span>
            <span>Settings</span>
          </button>

          <div className="mx-2 border-t border-surface-border" />

          {/* Sign out (placeholder) */}
          <button
            type="button"
            disabled
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-muted opacity-50 cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[18px]">logout</span>
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  )
}
