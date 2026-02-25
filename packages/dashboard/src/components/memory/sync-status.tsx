"use client"

interface SyncStatusProps {
  agentId: string
}

export function SyncStatus({ agentId }: SyncStatusProps): React.JSX.Element {
  // TODO: poll or SSE for sync state
  void agentId

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-600" />
      Not synced
    </span>
  )
}
