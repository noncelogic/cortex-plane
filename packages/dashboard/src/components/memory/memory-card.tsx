import type { MemoryRecord } from "@/lib/api-client"

interface MemoryCardProps {
  record: MemoryRecord
}

export function MemoryCard({ record }: MemoryCardProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="mb-1 flex items-center gap-2 text-xs text-gray-500">
        <span className="rounded bg-gray-800 px-1.5 py-0.5">{record.type}</span>
        <span>importance: {record.importance}</span>
        {record.score !== undefined && <span>score: {record.score.toFixed(2)}</span>}
      </div>
      <p className="text-sm text-gray-200">{record.content}</p>
      {record.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {record.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-cortex-900/30 px-1.5 py-0.5 text-xs text-cortex-300"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
