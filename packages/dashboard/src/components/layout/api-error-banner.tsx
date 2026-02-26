"use client"

import type { ApiErrorCode } from "@/lib/api-client"

interface ApiErrorBannerProps {
  error: string
  errorCode: ApiErrorCode | null
  onRetry?: () => void
}

const ERROR_CONFIG: Record<string, { icon: string; title: string; className: string }> = {
  CONNECTION_REFUSED: {
    icon: "cloud_off",
    title: "Control plane unavailable",
    className: "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  TIMEOUT: {
    icon: "schedule",
    title: "Request timed out",
    className: "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  AUTH_ERROR: {
    icon: "lock",
    title: "Authentication required",
    className: "border-red-500/20 bg-red-500/10 text-red-500",
  },
  SERVER_ERROR: {
    icon: "error",
    title: "Server error",
    className: "border-red-500/20 bg-red-500/10 text-red-500",
  },
}

const DEFAULT_CONFIG = {
  icon: "error_outline",
  title: "Something went wrong",
  className: "border-red-500/20 bg-red-500/10 text-red-500",
}

export function ApiErrorBanner({ error, errorCode, onRetry }: ApiErrorBannerProps): React.JSX.Element {
  const config = (errorCode && ERROR_CONFIG[errorCode]) ?? DEFAULT_CONFIG

  return (
    <div className={`flex items-start gap-3 rounded-xl border px-5 py-4 ${config.className}`}>
      <span className="material-symbols-outlined mt-0.5 text-[20px]">{config.icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold">{config.title}</p>
        <p className="mt-0.5 text-xs opacity-80">{error}</p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-white/20"
        >
          <span className="material-symbols-outlined text-[14px]">refresh</span>
          Retry
        </button>
      )}
    </div>
  )
}
