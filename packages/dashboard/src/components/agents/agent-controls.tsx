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
        className="rounded-md border border-surface-border px-3 py-1.5 text-sm text-text-muted hover:bg-secondary"
      >
        Pause
      </button>
      <button
        type="button"
        className="rounded-md border border-surface-border px-3 py-1.5 text-sm text-text-muted hover:bg-secondary"
      >
        Resume
      </button>
    </div>
  )
}
