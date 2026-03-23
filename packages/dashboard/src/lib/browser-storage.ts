"use client"

type StorageKind = "localStorage" | "sessionStorage"

function resolveStorage(kind: StorageKind): Storage | null {
  if (typeof window === "undefined") return null

  try {
    return window[kind]
  } catch {
    return null
  }
}

function safeGetItem(kind: StorageKind, key: string): string | null {
  const storage = resolveStorage(kind)
  if (!storage) return null

  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(kind: StorageKind, key: string, value: string): void {
  const storage = resolveStorage(kind)
  if (!storage) return

  try {
    storage.setItem(key, value)
  } catch {
    // best effort only
  }
}

function safeRemoveItem(kind: StorageKind, key: string): void {
  const storage = resolveStorage(kind)
  if (!storage) return

  try {
    storage.removeItem(key)
  } catch {
    // best effort only
  }
}

export const getLocalStorageItem = (key: string) => safeGetItem("localStorage", key)
export const setLocalStorageItem = (key: string, value: string) =>
  safeSetItem("localStorage", key, value)
export const removeLocalStorageItem = (key: string) => safeRemoveItem("localStorage", key)
export const getSessionStorageItem = (key: string) => safeGetItem("sessionStorage", key)
export const setSessionStorageItem = (key: string, value: string) =>
  safeSetItem("sessionStorage", key, value)
export const removeSessionStorageItem = (key: string) => safeRemoveItem("sessionStorage", key)
