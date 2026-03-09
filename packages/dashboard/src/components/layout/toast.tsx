"use client"

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToastVariant = "success" | "error" | "warning" | "info"

interface Toast {
  id: string
  message: string
  variant: ToastVariant
}

interface ToastContextValue {
  toasts: Toast[]
  addToast: (message: string, variant?: ToastVariant) => void
  removeToast: (id: string) => void
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null)

let nextId = 0

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const AUTO_DISMISS_MS = 4_000

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const addToast = useCallback(
    (message: string, variant: ToastVariant = "info") => {
      const id = `toast-${++nextId}`
      setToasts((prev) => [...prev, { id, message, variant }])
      const timer = setTimeout(() => removeToast(id), AUTO_DISMISS_MS)
      timersRef.current.set(id, timer)
    },
    [removeToast],
  )

  // Cleanup timers on unmount
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
    }
  }, [])

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error("useToast must be used within a ToastProvider")
  return ctx
}

// ---------------------------------------------------------------------------
// Toast container + items
// ---------------------------------------------------------------------------

const VARIANT_STYLES: Record<ToastVariant, { bg: string; icon: string; iconColor: string }> = {
  success: {
    bg: "border-emerald-500/30 bg-emerald-500/10",
    icon: "check_circle",
    iconColor: "text-emerald-400",
  },
  error: {
    bg: "border-red-500/30 bg-red-500/10",
    icon: "error",
    iconColor: "text-red-400",
  },
  warning: {
    bg: "border-amber-500/30 bg-amber-500/10",
    icon: "warning",
    iconColor: "text-amber-400",
  },
  info: {
    bg: "border-blue-500/30 bg-blue-500/10",
    icon: "info",
    iconColor: "text-blue-400",
  },
}

function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: string) => void
}): React.JSX.Element | null {
  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => {
        const style = VARIANT_STYLES[t.variant]
        return (
          <div
            key={t.id}
            role="alert"
            className={`flex items-center gap-2 rounded-lg border px-4 py-3 shadow-lg backdrop-blur-sm ${style.bg} animate-in slide-in-from-right-5 fade-in duration-200`}
          >
            <span className={`material-symbols-outlined text-lg ${style.iconColor}`}>
              {style.icon}
            </span>
            <p className="text-sm font-medium text-slate-200">{t.message}</p>
            <button
              onClick={() => onDismiss(t.id)}
              className="ml-2 rounded p-0.5 text-slate-400 transition-colors hover:text-white"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
