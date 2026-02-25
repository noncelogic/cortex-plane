"use client"

import { useCallback, useState } from "react"

import { steerAgent } from "@/lib/api-client"

interface SteerInputProps {
  agentId: string
  onStop?: () => void
}

export function SteerInput({ agentId, onStop }: SteerInputProps): React.JSX.Element {
  const [message, setMessage] = useState("")
  const [priority, setPriority] = useState<"normal" | "high">("normal")
  const [sending, setSending] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!message.trim() || sending) return

      setSending(true)
      setError(null)
      setConfirmation(null)

      try {
        const res = await steerAgent(agentId, { message: message.trim(), priority })
        setConfirmation(`Instruction accepted (${res.steerMessageId.slice(0, 8)})`)
        setMessage("")
        setTimeout(() => setConfirmation(null), 4000)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send instruction")
      } finally {
        setSending(false)
      }
    },
    [agentId, message, priority, sending],
  )

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-primary/10 dark:bg-primary/5">
      {/* Header */}
      <div className="mb-4 flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">directions</span>
        <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
          Steering Controls
        </h3>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
        {/* Textarea */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-slate-500">
            Override Instruction
          </label>
          <textarea
            value={message}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setMessage(e.target.value)}
            placeholder="Enter steering instruction for the agent..."
            rows={4}
            disabled={sending}
            className="w-full resize-none rounded-lg border border-slate-300 bg-slate-100 p-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-primary/20 dark:bg-bg-dark dark:text-slate-100 dark:placeholder:text-slate-600"
          />
        </div>

        {/* Priority toggle */}
        <label className="flex items-center gap-2 text-xs text-slate-500">
          <input
            type="checkbox"
            checked={priority === "high"}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setPriority(e.target.checked ? "high" : "normal")
            }
            className="rounded border-slate-400 dark:border-slate-600"
          />
          <span className="font-medium">High Priority</span>
        </label>

        {/* Buttons */}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={sending || !message.trim()}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px]">send</span>
            {sending ? "Sending..." : "Update Instructions"}
          </button>

          {onStop && (
            <button
              type="button"
              onClick={onStop}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-red-50 hover:text-red-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            >
              <span className="material-symbols-outlined text-[18px]">stop_circle</span>
              Stop
            </button>
          )}
        </div>

        {/* Confirmation */}
        {confirmation && (
          <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-500">
            <span className="material-symbols-outlined text-[16px]">check_circle</span>
            {confirmation}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-500">
            <span className="material-symbols-outlined text-[16px]">error</span>
            {error}
          </div>
        )}
      </form>
    </div>
  )
}
