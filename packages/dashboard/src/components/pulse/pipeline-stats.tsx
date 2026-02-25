interface StatProps {
  label: string
  value: number
}

function Stat({ label, value }: StatProps): React.JSX.Element {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-center">
      <p className="text-2xl font-bold text-gray-100">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  )
}

export function PipelineStats(): React.JSX.Element {
  // TODO: fetch from API
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Drafts" value={0} />
      <Stat label="In Review" value={0} />
      <Stat label="Published" value={0} />
      <Stat label="Rejected" value={0} />
    </div>
  )
}
