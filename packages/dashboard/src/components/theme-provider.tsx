"use client"

import { createContext, useCallback, useContext, useEffect, useState } from "react"

type Theme = "light" | "dark"

const THEME_KEY = "cortex-theme"

const ThemeContext = createContext<{
  theme: Theme
  toggle: () => void
}>({ theme: "dark", toggle: () => {} })

export function useTheme() {
  return useContext(ThemeContext)
}

export function readThemePreference(): Theme {
  if (typeof window === "undefined") return "dark"

  try {
    const stored = window.localStorage.getItem(THEME_KEY)
    if (stored === "light" || stored === "dark") return stored
    return "dark"
  } catch {
    // Mobile browsers (e.g. private mode / embedded webviews) can throw
    // SecurityError when storage is unavailable. Fall back safely.
    return "dark"
  }
}

export function writeThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Best effort only; never crash render path due to storage policy.
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark")

  useEffect(() => {
    const stored = readThemePreference()
    setTheme(stored)
    document.documentElement.classList.toggle("dark", stored === "dark")
  }, [])

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark"
      writeThemePreference(next)
      document.documentElement.classList.toggle("dark", next === "dark")
      return next
    })
  }, [])

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>
}
