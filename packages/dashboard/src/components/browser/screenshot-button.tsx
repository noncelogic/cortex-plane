"use client"

interface ScreenshotButtonProps {
  agentId: string
}

export function ScreenshotButton({ agentId }: ScreenshotButtonProps): React.JSX.Element {
  // TODO: POST /agents/:id/observe/screenshot
  void agentId

  return (
    <button
      type="button"
      className="rounded-md border border-surface-border px-3 py-1.5 text-sm text-text-muted hover:bg-secondary"
    >
      Screenshot
    </button>
  )
}
