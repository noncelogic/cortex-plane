"use client"

import { useState } from "react"

import { SyncStatus } from "./sync-status"

interface MemoryEditorProps {
  agentId: string
}

export function MemoryEditor({ agentId }: MemoryEditorProps): React.JSX.Element {
  const [content, setContent] = useState("")

  void agentId

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300">MEMORY.md</h2>
        <SyncStatus agentId={agentId} />
      </div>
      <textarea
        value={content}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
        rows={12}
        className="w-full rounded-lg border border-gray-700 bg-gray-900 p-3 font-mono text-sm text-gray-200 placeholder-gray-500 focus:border-cortex-500 focus:outline-none"
        placeholder="# Memory content..."
      />
      <button
        type="button"
        className="rounded-md bg-cortex-600 px-4 py-2 text-sm font-medium text-white hover:bg-cortex-500"
      >
        Save &amp; Sync
      </button>
    </section>
  )
}
