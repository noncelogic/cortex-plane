"use client"

interface AgentControlsProps {
  agentId: string
}

export function AgentControls({ agentId }: AgentControlsProps): React.JSX.Element {
  // TODO: wire to api-client for pause/resume actions
  void agentId

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        className="rounded-md border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800"
      >
        Pause
      </button>
      <button
        type="button"
        className="rounded-md border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800"
      >
        Resume
      </button>
    </div>
  )
}
