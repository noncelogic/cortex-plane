"use client"

import { createContext, useCallback, useContext, useEffect, useState } from "react"

import { getLocalStorageItem, setLocalStorageItem } from "@/lib/browser-storage"

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
  const stored = getLocalStorageItem(THEME_KEY)
  if (stored === "light" || stored === "dark") return stored
  return "dark"
}

export function writeThemePreference(theme: Theme): void {
  setLocalStorageItem(THEME_KEY, theme)
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
