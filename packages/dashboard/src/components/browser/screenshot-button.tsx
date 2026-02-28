"use client"

interface ScreenshotButtonProps {
  onCapture: () => void
  isCapturing: boolean
}

export function ScreenshotButton({
  onCapture,
  isCapturing,
}: ScreenshotButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onCapture}
      disabled={isCapturing}
      className="flex items-center gap-1.5 rounded-lg border border-chrome-border bg-chrome-bg px-3 py-1.5 text-sm font-medium text-slate-300 transition-colors hover:bg-surface-border hover:text-white disabled:pointer-events-none disabled:opacity-50"
    >
      <span className={`material-symbols-outlined text-sm ${isCapturing ? "animate-spin" : ""}`}>
        {isCapturing ? "sync" : "photo_camera"}
      </span>
      {isCapturing ? "Capturing..." : "Screenshot"}
    </button>
  )
}
