"use client"

import { useState } from "react"

import type { MemoryRecord } from "@/lib/api-client"

import { MemoryCard } from "./memory-card"

interface MemorySearchProps {
  agentId?: string
}

export function MemorySearch({ agentId }: MemorySearchProps): React.JSX.Element {
  const [query, setQuery] = useState("")
  const results: MemoryRecord[] = []

  void agentId

  return (
    <div className="space-y-4">
      <form className="flex gap-2" onSubmit={(e) => e.preventDefault()}>
        <input
          type="text"
          value={query}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          placeholder="Semantic search..."
          className="flex-1 rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-cortex-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-md bg-cortex-600 px-4 py-2 text-sm font-medium text-white hover:bg-cortex-500"
        >
          Search
        </button>
      </form>

      {results.length === 0 ? (
        <p className="text-sm text-gray-500">Enter a query to search memories.</p>
      ) : (
        <div className="space-y-3">
          {results.map((record) => (
            <MemoryCard key={record.id} record={record} />
          ))}
        </div>
      )}
    </div>
  )
}
