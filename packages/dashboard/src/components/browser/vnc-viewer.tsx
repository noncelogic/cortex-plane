"use client"

interface VncViewerProps {
  agentId: string
}

export function VncViewer({ agentId }: VncViewerProps): React.JSX.Element {
  // TODO: connect to WebSocket VNC proxy at /agents/:id/observe/vnc
  void agentId

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-console-bg">
      <div className="flex aspect-video items-center justify-center text-text-muted">
        <p className="text-sm">noVNC viewer — connect to agent browser</p>
      </div>
      <div className="flex items-center justify-between border-t border-surface-border px-3 py-2 text-xs text-text-muted">
        <span>Quality: Auto</span>
        <span>Disconnected</span>
      </div>
    </div>
  )
}
