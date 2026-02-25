interface DraftCardProps {
  title: string
  agent: string
  type: string
  wordCount: number
  summary: string
}

export function DraftCard({
  title,
  agent,
  type,
  wordCount,
  summary,
}: DraftCardProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <h3 className="mb-1 font-medium text-gray-100">{title}</h3>
      <div className="mb-2 flex gap-2 text-xs text-gray-500">
        <span>{agent}</span>
        <span>{type}</span>
        <span>{wordCount} words</span>
      </div>
      <p className="mb-3 text-sm text-gray-400">{summary}</p>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded bg-cortex-600 px-3 py-1 text-xs text-white hover:bg-cortex-500"
        >
          Preview
        </button>
        <button
          type="button"
          className="rounded bg-success px-3 py-1 text-xs text-white hover:bg-green-600"
        >
          Approve &amp; Publish
        </button>
      </div>
    </div>
  )
}
