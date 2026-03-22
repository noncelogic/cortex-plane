import { afterEach, describe, expect, it } from "vitest"

import {
  readSidebarCollapsedPreference,
  writeSidebarCollapsedPreference,
} from "@/components/layout/nav-shell"

describe("nav shell sidebar storage guards", () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })

  it("returns false instead of throwing when localStorage.getItem throws", () => {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError")
        },
      },
    }

    expect(readSidebarCollapsedPreference()).toBe(false)
  })

  it("does not throw when localStorage.setItem throws", () => {
    ;(globalThis as { window?: unknown }).window = {
      localStorage: {
        setItem: () => {
          throw new Error("SecurityError")
        },
      },
    }

    expect(() => writeSidebarCollapsedPreference(true)).not.toThrow()
  })
})
