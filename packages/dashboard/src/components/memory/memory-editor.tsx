"use client"

import { useCallback, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { syncMemory } from "@/lib/api-client"

import { SyncStatus } from "./sync-status"

interface MemoryEditorProps {
  agentId: string
}

export function MemoryEditor({ agentId }: MemoryEditorProps): React.JSX.Element {
  const [content, setContent] = useState("")
  const [saved, setSaved] = useState(false)
  const { isLoading, error, execute } = useApi(
    (id: unknown) => syncMemory(id as string),
    `editor-sync:${agentId}`,
  )

  const handleSave = useCallback(async () => {
    const result = await execute(agentId)
    if (result) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    }
  }, [execute, agentId])

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-main">MEMORY.md</h2>
        <SyncStatus agentId={agentId} />
      </div>
      <textarea
        value={content}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
        rows={12}
        className="w-full rounded-lg border border-surface-border bg-console-bg p-3 font-mono text-sm text-slate-200 placeholder-text-muted focus:border-cortex-500 focus:outline-none"
        placeholder="# Memory content..."
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={isLoading}
          className="rounded-md bg-cortex-600 px-4 py-2 text-sm font-medium text-white hover:bg-cortex-500 disabled:opacity-50"
        >
          {isLoading ? "Saving..." : saved ? "Saved!" : "Save & Sync"}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </section>
  )
}
