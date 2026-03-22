import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getSessionStorageItem,
  removeSessionStorageItem,
  setSessionStorageItem,
} from "@/lib/browser-storage"

describe("browser storage helpers", () => {
  const originalWindow = globalThis.window

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })

  it("returns null when sessionStorage access itself throws", () => {
    const nextWindow = {}
    Object.defineProperty(nextWindow, "sessionStorage", {
      get() {
        throw new Error("SecurityError")
      },
    })
    ;(globalThis as { window?: unknown }).window = nextWindow

    expect(getSessionStorageItem("cortex_csrf")).toBeNull()
  })

  it("does not throw when sessionStorage methods throw", () => {
    ;(globalThis as { window?: unknown }).window = {
      sessionStorage: {
        setItem: () => {
          throw new Error("SecurityError")
        },
        removeItem: () => {
          throw new Error("SecurityError")
        },
      },
    }

    expect(() => setSessionStorageItem("cortex_csrf", "token")).not.toThrow()
    expect(() => removeSessionStorageItem("cortex_csrf")).not.toThrow()
  })
})
