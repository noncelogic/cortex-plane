"use client"

import type { TraceStatus } from "@/lib/api-client"
import { relativeTime } from "@/lib/format"

interface TraceControlsProps {
  traceStatus: TraceStatus
  startedAt?: string
  onStartTrace: () => void
  onStopTrace: () => void
  isStarting: boolean
  isStopping: boolean
}

export function TraceControls({
  traceStatus,
  startedAt,
  onStartTrace,
  onStopTrace,
  isStarting,
  isStopping,
}: TraceControlsProps): React.JSX.Element {
  const isRecording = traceStatus === "recording"
  const isBusy = isStarting || isStopping

  return (
    <div className="flex items-center gap-3 rounded-lg border border-chrome-border bg-chrome-bg px-3 py-2">
      {/* Status indicator */}
      <div className="flex items-center gap-2">
        <span
          className={`size-2 rounded-full ${
            isRecording ? "animate-pulse bg-red-500" : "bg-slate-500"
          }`}
        />
        <span className={`text-xs font-bold ${isRecording ? "text-red-400" : "text-slate-400"}`}>
          {isRecording ? "Recording" : "Idle"}
        </span>
      </div>

      {/* Duration hint */}
      {isRecording && startedAt && (
        <span className="text-[10px] text-slate-500">Started {relativeTime(startedAt)}</span>
      )}

      {/* Start / Stop button */}
      <button
        type="button"
        onClick={isRecording ? onStopTrace : onStartTrace}
        disabled={isBusy}
        className={`ml-auto flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-bold transition-colors disabled:pointer-events-none disabled:opacity-50 ${
          isRecording
            ? "border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20"
            : "border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
        }`}
      >
        <span className={`material-symbols-outlined text-sm ${isBusy ? "animate-spin" : ""}`}>
          {isBusy ? "sync" : isRecording ? "stop_circle" : "fiber_manual_record"}
        </span>
        {isStarting ? "Starting..." : isStopping ? "Stopping..." : isRecording ? "Stop" : "Record"}
      </button>
    </div>
  )
}
