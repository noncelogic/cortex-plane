"use client"

interface TraceControlsProps {
  agentId: string
}

export function TraceControls({ agentId }: TraceControlsProps): React.JSX.Element {
  // TODO: GET /agents/:id/observe/trace, POST start/stop
  void agentId

  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 p-3">
      <span className="text-xs text-gray-400">Trace Recording</span>
      <span className="text-xs text-gray-600">Idle</span>
      <button
        type="button"
        className="ml-auto rounded-md border border-gray-700 px-3 py-1 text-xs text-gray-300 hover:bg-gray-800"
      >
        Start Recording
      </button>
    </div>
  )
}
