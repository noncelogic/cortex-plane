"use client"

interface JobRetryButtonProps {
  jobId: string
}

export function JobRetryButton({ jobId }: JobRetryButtonProps): React.JSX.Element {
  // TODO: POST /jobs/:id/retry (endpoint TBD)
  void jobId

  return (
    <button
      type="button"
      className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
    >
      Retry
    </button>
  )
}
