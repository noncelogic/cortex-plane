import { afterEach, describe, expect, it } from "vitest"

import { readThemePreference, writeThemePreference } from "@/components/theme-provider"

describe("theme provider storage guards", () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })

  it("returns 'dark' instead of throwing when localStorage.getItem throws", () => {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError")
        },
      },
    }

    expect(readThemePreference()).toBe("dark")
  })

  it("does not throw when localStorage.setItem throws", () => {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        setItem: () => {
          throw new Error("SecurityError")
        },
      },
    }

    expect(() => writeThemePreference("light")).not.toThrow()
  })

  it("returns stored theme when localStorage works", () => {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => "light",
      },
    }

    expect(readThemePreference()).toBe("light")
  })

  it("returns 'dark' for invalid stored value", () => {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => "invalid-value",
      },
    }

    expect(readThemePreference()).toBe("dark")
  })
})
