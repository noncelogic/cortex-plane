"use client"

interface TraceControlsProps {
  agentId: string
}

export function TraceControls({ agentId }: TraceControlsProps): React.JSX.Element {
  // TODO: GET /agents/:id/observe/trace, POST start/stop
  void agentId

  return (
    <div className="flex items-center gap-3 rounded-lg border border-surface-border bg-surface-light p-3">
      <span className="text-xs text-text-muted">Trace Recording</span>
      <span className="text-xs text-text-muted">Idle</span>
      <button
        type="button"
        className="ml-auto rounded-md border border-surface-border px-3 py-1 text-xs text-text-muted hover:bg-secondary"
      >
        Start Recording
      </button>
    </div>
  )
}
