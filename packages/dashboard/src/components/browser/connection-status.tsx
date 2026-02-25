"use client"

import type { BrowserSessionStatus } from "@/lib/api-client"

interface ConnectionStatusProps {
  status: BrowserSessionStatus
  latencyMs?: number
  onReconnect?: () => void
}

const statusConfig: Record<
  BrowserSessionStatus,
  { label: string; dotClass: string; textClass: string; icon: string }
> = {
  connecting: {
    label: "Connecting",
    dotClass: "bg-yellow-400 animate-pulse",
    textClass: "text-yellow-400",
    icon: "sync",
  },
  connected: {
    label: "Live",
    dotClass: "bg-emerald-400 animate-pulse",
    textClass: "text-emerald-400",
    icon: "wifi",
  },
  disconnected: {
    label: "Disconnected",
    dotClass: "bg-slate-500",
    textClass: "text-slate-400",
    icon: "wifi_off",
  },
  error: {
    label: "Error",
    dotClass: "bg-red-500",
    textClass: "text-red-400",
    icon: "error",
  },
}

function qualityLabel(latencyMs: number): { label: string; colorClass: string } {
  if (latencyMs < 50) return { label: "Excellent", colorClass: "text-emerald-400" }
  if (latencyMs < 100) return { label: "Good", colorClass: "text-blue-400" }
  if (latencyMs < 200) return { label: "Fair", colorClass: "text-yellow-400" }
  return { label: "Poor", colorClass: "text-red-400" }
}

export function ConnectionStatus({
  status,
  latencyMs,
  onReconnect,
}: ConnectionStatusProps): React.JSX.Element {
  const config = statusConfig[status]
  const quality = latencyMs !== undefined ? qualityLabel(latencyMs) : null

  return (
    <div className="flex items-center gap-3">
      {/* Status dot + label */}
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${config.dotClass}`} />
        <span className={`text-xs font-bold ${config.textClass}`}>{config.label}</span>
      </div>

      {/* Latency */}
      {status === "connected" && latencyMs !== undefined && (
        <div className="flex items-center gap-1.5 rounded-md bg-slate-800/50 px-2 py-0.5">
          <span className="font-mono text-xs text-slate-400">{latencyMs}ms</span>
          {quality && (
            <span className={`text-[10px] font-bold ${quality.colorClass}`}>{quality.label}</span>
          )}
        </div>
      )}

      {/* Reconnect button */}
      {(status === "disconnected" || status === "error") && onReconnect && (
        <button
          type="button"
          onClick={onReconnect}
          className="flex items-center gap-1 rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-300 transition-colors hover:bg-slate-700"
        >
          <span className="material-symbols-outlined text-sm">refresh</span>
          Reconnect
        </button>
      )}
    </div>
  )
}
