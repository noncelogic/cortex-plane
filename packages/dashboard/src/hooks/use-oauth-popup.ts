"use client"

import { useCallback, useRef, useState } from "react"

import { exchangeOAuthConnect, initOAuthConnect } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OAuthPopupStatus = "idle" | "waiting" | "success" | "fallback"

export interface UseOAuthPopupReturn {
  /** Current status of the popup OAuth flow. */
  status: OAuthPopupStatus
  /** Error message if something went wrong during exchange. */
  error: string | null
  /** PKCE / state context needed if the caller falls back to code-paste. */
  fallbackContext: { authUrl: string; codeVerifier: string; state: string } | null
  /** Open the popup and begin the OAuth flow. */
  startFlow: (provider: string) => Promise<void>
  /** Cancel any in-progress flow, closing the popup if open. */
  cancel: () => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 500
const POPUP_TIMEOUT_MS = 30_000
const POPUP_WIDTH = 600
const POPUP_HEIGHT = 700

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useOAuthPopup(onSuccess?: () => void): UseOAuthPopupReturn {
  const [status, setStatus] = useState<OAuthPopupStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [fallbackContext, setFallbackContext] = useState<{
    authUrl: string
    codeVerifier: string
    state: string
  } | null>(null)

  const popupRef = useRef<Window | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep latest callback in a ref to avoid stale closures in the poll interval
  const onSuccessRef = useRef(onSuccess)
  onSuccessRef.current = onSuccess

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const cancel = useCallback(() => {
    cleanup()
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close()
    }
    popupRef.current = null
    setStatus("idle")
    setError(null)
    setFallbackContext(null)
  }, [cleanup])

  const startFlow = useCallback(
    async (provider: string) => {
      // Reset state
      cancel()
      setError(null)
      setStatus("waiting")

      // 1. Initialize the OAuth flow (get authUrl + PKCE params)
      let authUrl: string
      let codeVerifier: string
      let state: string
      try {
        const init = await initOAuthConnect(provider)
        authUrl = init.authUrl
        codeVerifier = init.codeVerifier
        state = init.state
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to initialize OAuth flow")
        setStatus("idle")
        return
      }

      // Store context for potential fallback
      setFallbackContext({ authUrl, codeVerifier, state })

      // 2. Open popup
      const left = Math.round(screen.width / 2 - POPUP_WIDTH / 2)
      const top = Math.round(screen.height / 2 - POPUP_HEIGHT / 2)
      const features = `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},toolbar=no,menubar=no`
      const popup = window.open(authUrl, "cortex_oauth_popup", features)

      if (!popup || popup.closed) {
        // Popup was blocked — fall back to code-paste
        setStatus("fallback")
        return
      }

      popupRef.current = popup

      // 3. Poll popup location
      const startTime = Date.now()

      timerRef.current = setInterval(() => {
        // Popup was closed by the user before we got a URL
        if (!popup || popup.closed) {
          cleanup()
          // If we didn't succeed yet, go to fallback so user can paste
          setStatus((prev) => (prev === "waiting" ? "fallback" : prev))
          return
        }

        // Check if we've timed out
        if (Date.now() - startTime > POPUP_TIMEOUT_MS) {
          cleanup()
          setStatus("fallback")
          return
        }

        // Try to read the popup URL. While on the provider's domain this
        // throws a cross-origin error — expected and ignored. Once the
        // browser redirects to localhost the page will fail to load, but
        // Chrome/Edge typically allow reading the URL in that state.
        try {
          const href = popup.location.href
          if (!href || href === "about:blank") return

          // Check if the redirect landed on localhost (our redirect URI)
          if (href.startsWith("http://localhost") || href.startsWith("http://127.0.0.1")) {
            cleanup()
            popup.close()
            popupRef.current = null

            // Extract code from the URL and exchange it
            setStatus("waiting") // keep "waiting" while exchanging
            void (async () => {
              try {
                await exchangeOAuthConnect(provider, {
                  pastedUrl: href,
                  codeVerifier,
                  state,
                })
                setStatus("success")
                setFallbackContext(null)
                onSuccessRef.current?.()
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : "Failed to exchange authorization code",
                )
                setStatus("fallback")
              }
            })()
          }
        } catch {
          // Cross-origin error — expected while on provider domain.
        }
      }, POLL_INTERVAL_MS)

      // 4. Safety-net timeout (interval also checks elapsed time)
      timeoutRef.current = setTimeout(() => {
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
        setStatus((prev) => (prev === "waiting" ? "fallback" : prev))
      }, POPUP_TIMEOUT_MS + POLL_INTERVAL_MS)
    },
    [cancel, cleanup],
  )

  return { status, error, fallbackContext, startFlow, cancel }
}
