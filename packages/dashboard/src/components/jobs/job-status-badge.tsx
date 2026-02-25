import type { JobStatus } from "@/lib/api-client"

const statusStyles: Record<JobStatus, string> = {
  PENDING: "bg-gray-500/10 text-gray-400",
  SCHEDULED: "bg-blue-400/10 text-blue-400",
  RUNNING: "bg-green-400/10 text-green-400",
  WAITING_FOR_APPROVAL: "bg-yellow-400/10 text-yellow-400",
  COMPLETED: "bg-green-400/10 text-green-400",
  FAILED: "bg-red-400/10 text-red-400",
  TIMED_OUT: "bg-orange-400/10 text-orange-400",
  RETRYING: "bg-yellow-400/10 text-yellow-400",
  DEAD_LETTER: "bg-red-400/10 text-red-400",
}

interface JobStatusBadgeProps {
  status: JobStatus
}

export function JobStatusBadge({ status }: JobStatusBadgeProps): React.JSX.Element {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[status]}`}>
      {status.replace(/_/g, " ")}
    </span>
  )
}
