"use client"

import { useCallback, useState } from "react"

import { ApiError } from "@/lib/api-client"

interface UseApiState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

interface UseApiReturn<T> extends UseApiState<T> {
  execute: (...args: unknown[]) => Promise<T | null>
  reset: () => void
}

export function useApi<T>(apiFn: (...args: unknown[]) => Promise<T>): UseApiReturn<T> {
  const [state, setState] = useState<UseApiState<T>>({
    data: null,
    loading: false,
    error: null,
  })

  const execute = useCallback(
    async (...args: unknown[]): Promise<T | null> => {
      setState({ data: null, loading: true, error: null })
      try {
        const data = await apiFn(...args)
        setState({ data, loading: false, error: null })
        return data
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "An error occurred"
        setState({ data: null, loading: false, error: message })
        return null
      }
    },
    [apiFn],
  )

  const reset = useCallback(() => {
    setState({ data: null, loading: false, error: null })
  }, [])

  return { ...state, execute, reset }
}
