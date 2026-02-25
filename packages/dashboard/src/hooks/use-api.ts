"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { ApiError } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Request deduplication cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  promise: Promise<T>
  timestamp: number
}

/**
 * Module-level cache that deduplicates concurrent requests with the same key.
 * Entries expire after 2 seconds so sequential calls still hit the API.
 */
const inflightCache = new Map<string, CacheEntry<unknown>>()
const DEDUP_WINDOW_MS = 2_000

function deduped<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflightCache.get(key)
  if (existing && Date.now() - existing.timestamp < DEDUP_WINDOW_MS) {
    return existing.promise as Promise<T>
  }
  const promise = fn().finally(() => {
    // Clean up after the dedup window
    setTimeout(() => inflightCache.delete(key), DEDUP_WINDOW_MS)
  })
  inflightCache.set(key, { promise, timestamp: Date.now() })
  return promise
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseApiState<T> {
  data: T | null
  isLoading: boolean
  error: string | null
}

interface UseApiReturn<T> extends UseApiState<T> {
  /** Execute the API call (deduplicates concurrent calls with same args) */
  execute: (...args: unknown[]) => Promise<T | null>
  /** Optimistically set data, then optionally revalidate */
  mutate: (updater: T | ((prev: T | null) => T | null), revalidate?: boolean) => void
  /** Reset state to initial */
  reset: () => void
  /** Alias for isLoading for backward compat */
  loading: boolean
}

export function useApi<T>(
  apiFn: (...args: unknown[]) => Promise<T>,
  dedupKey?: string,
): UseApiReturn<T> {
  const [state, setState] = useState<UseApiState<T>>({
    data: null,
    isLoading: false,
    error: null,
  })

  // Keep the latest apiFn for use inside callbacks without re-creating them
  const apiFnRef = useRef(apiFn)
  apiFnRef.current = apiFn

  // Store the last args for revalidation after mutate
  const lastArgsRef = useRef<unknown[]>([])

  const execute = useCallback(
    async (...args: unknown[]): Promise<T | null> => {
      lastArgsRef.current = args
      setState((prev) => ({ ...prev, isLoading: true, error: null }))

      try {
        const key = dedupKey ?? `useApi:${apiFnRef.current.name}:${JSON.stringify(args)}`
        const data = await deduped(key, () => apiFnRef.current(...args))
        setState({ data, isLoading: false, error: null })
        return data
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "An error occurred"
        setState((prev) => ({ ...prev, isLoading: false, error: message }))
        return null
      }
    },
    [dedupKey],
  )

  const mutate = useCallback(
    (updater: T | ((prev: T | null) => T | null), revalidate = false) => {
      setState((prev) => {
        const next =
          typeof updater === "function"
            ? (updater as (p: T | null) => T | null)(prev.data)
            : updater
        return { ...prev, data: next }
      })
      if (revalidate) {
        // Re-run with last known args
        void execute(...lastArgsRef.current)
      }
    },
    [execute],
  )

  const reset = useCallback(() => {
    setState({ data: null, isLoading: false, error: null })
  }, [])

  return { ...state, loading: state.isLoading, execute, mutate, reset }
}

// ---------------------------------------------------------------------------
// Auto-fetching variant
// ---------------------------------------------------------------------------

/**
 * Like useApi, but automatically executes on mount and when deps change.
 * Equivalent to SWR's default behavior.
 */
export function useApiQuery<T>(
  apiFn: () => Promise<T>,
  deps: unknown[] = [],
): Omit<UseApiReturn<T>, "execute"> & { refetch: () => Promise<T | null> } {
  const { execute, ...rest } = useApi(apiFn)

  useEffect(() => {
    void execute()
  }, deps)

  return { ...rest, refetch: execute }
}
