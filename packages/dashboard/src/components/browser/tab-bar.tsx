"use client"

interface TabBarProps {
  agentId: string
}

export function TabBar({ agentId }: TabBarProps): React.JSX.Element {
  // TODO: fetch from GET /agents/:id/observe/tabs
  void agentId

  return (
    <div className="flex gap-1 overflow-x-auto rounded-md border border-gray-800 bg-gray-900 p-1">
      <span className="rounded px-3 py-1 text-xs text-gray-500">No tabs open</span>
    </div>
  )
}
