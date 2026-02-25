"use client"

import { useState } from "react"

interface SteerInputProps {
  agentId: string
}

export function SteerInput({ agentId }: SteerInputProps): React.JSX.Element {
  const [message, setMessage] = useState("")
  const [priority, setPriority] = useState<"normal" | "high">("normal")
  const [sending, setSending] = useState(false)

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!message.trim()) return

    setSending(true)
    try {
      // TODO: wire to api-client
      void agentId
      void priority
      setMessage("")
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={message}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMessage(e.target.value)}
        placeholder="Send steering instruction..."
        className="flex-1 rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-cortex-500 focus:outline-none"
        disabled={sending}
      />
      <label className="flex items-center gap-1.5 text-xs text-gray-400">
        <input
          type="checkbox"
          checked={priority === "high"}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setPriority(e.target.checked ? "high" : "normal")
          }
          className="rounded border-gray-600"
        />
        High
      </label>
      <button
        type="submit"
        disabled={sending || !message.trim()}
        className="rounded-md bg-cortex-600 px-4 py-2 text-sm font-medium text-white hover:bg-cortex-500 disabled:opacity-50"
      >
        Send
      </button>
    </form>
  )
}
