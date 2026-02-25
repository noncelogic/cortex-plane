"use client"

import { useState } from "react"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PublishActionProps {
  contentId: string
  contentTitle: string
  onPublish: (contentId: string, channel: string) => Promise<void>
  onCancel: () => void
}

type PublishState = "idle" | "confirming" | "loading" | "success" | "error"

const CHANNELS = [
  { value: "website", label: "Website", icon: "language" },
  { value: "blog", label: "Blog", icon: "rss_feed" },
  { value: "newsletter", label: "Newsletter", icon: "mail" },
  { value: "social", label: "Social Media", icon: "share" },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PublishAction({
  contentId,
  contentTitle,
  onPublish,
  onCancel,
}: PublishActionProps): React.JSX.Element {
  const [state, setState] = useState<PublishState>("confirming")
  const [channel, setChannel] = useState(CHANNELS[0]!.value)
  const [errorMsg, setErrorMsg] = useState("")

  const handlePublish = async (): Promise<void> => {
    setState("loading")
    try {
      await onPublish(contentId, channel)
      setState("success")
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to publish")
      setState("error")
    }
  }

  if (state === "success") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-900/20">
              <span className="material-symbols-outlined text-2xl text-emerald-500">
                check_circle
              </span>
            </div>
            <h3 className="text-lg font-bold text-text-main dark:text-white">Published!</h3>
            <p className="text-sm text-slate-500">
              &ldquo;{contentTitle}&rdquo; has been published to {channel}.
            </p>
            <button
              type="button"
              onClick={onCancel}
              className="mt-2 rounded-lg bg-primary px-6 py-2 text-sm font-bold text-white transition-all hover:bg-primary/90"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-900/20">
            <span className="material-symbols-outlined text-xl text-emerald-500">send</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-text-main dark:text-white">Publish Content</h3>
            <p className="text-xs text-slate-500">Choose a target channel</p>
          </div>
        </div>

        <p className="mb-4 truncate text-sm text-slate-600 dark:text-slate-300">
          &ldquo;{contentTitle}&rdquo;
        </p>

        {/* Channel selector */}
        <div className="mb-4 space-y-2">
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Target Channel
          </label>
          <div className="grid grid-cols-2 gap-2">
            {CHANNELS.map((ch) => (
              <button
                key={ch.value}
                type="button"
                onClick={() => setChannel(ch.value)}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-all ${
                  channel === ch.value
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-slate-200 text-slate-600 hover:border-slate-300 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600"
                }`}
              >
                <span className="material-symbols-outlined text-lg">{ch.icon}</span>
                {ch.label}
              </button>
            ))}
          </div>
        </div>

        {/* Error message */}
        {state === "error" && (
          <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {errorMsg}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={state === "loading"}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handlePublish}
            disabled={state === "loading"}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-2 text-sm font-bold text-white shadow-md shadow-emerald-600/20 transition-all hover:bg-emerald-500 active:scale-95 disabled:opacity-50"
          >
            {state === "loading" ? (
              <>
                <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
                Publishing...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-lg">send</span>
                Publish Now
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
