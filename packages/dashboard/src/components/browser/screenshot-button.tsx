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
      className="rounded-md border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800"
    >
      Screenshot
    </button>
  )
}
