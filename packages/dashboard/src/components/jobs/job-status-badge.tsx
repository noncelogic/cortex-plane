import type { JobStatus } from "@/lib/api-client"

const statusStyles: Record<
  JobStatus,
  { dot: string; bg: string; text: string; border: string; label: string }
> = {
  COMPLETED: {
    dot: "bg-emerald-500",
    bg: "bg-emerald-500/10",
    text: "text-emerald-500 dark:text-emerald-400",
    border: "border-emerald-500/20",
    label: "Completed",
  },
  FAILED: {
    dot: "bg-red-500",
    bg: "bg-red-500/10",
    text: "text-red-500 dark:text-red-400",
    border: "border-red-500/20",
    label: "Failed",
  },
  RUNNING: {
    dot: "bg-blue-400 animate-pulse",
    bg: "bg-blue-500/10",
    text: "text-blue-500 dark:text-blue-400",
    border: "border-blue-500/20",
    label: "Running",
  },
  RETRYING: {
    dot: "bg-yellow-400",
    bg: "bg-yellow-500/10",
    text: "text-yellow-500 dark:text-yellow-400",
    border: "border-yellow-500/20",
    label: "Retrying",
  },
  PENDING: {
    dot: "bg-slate-400",
    bg: "bg-slate-500/10",
    text: "text-slate-500 dark:text-slate-400",
    border: "border-slate-500/20",
    label: "Pending",
  },
  SCHEDULED: {
    dot: "bg-blue-400",
    bg: "bg-blue-500/10",
    text: "text-blue-500 dark:text-blue-400",
    border: "border-blue-500/20",
    label: "Scheduled",
  },
  WAITING_FOR_APPROVAL: {
    dot: "bg-amber-400",
    bg: "bg-amber-500/10",
    text: "text-amber-500 dark:text-amber-400",
    border: "border-amber-500/20",
    label: "Awaiting Approval",
  },
  TIMED_OUT: {
    dot: "bg-orange-500",
    bg: "bg-orange-500/10",
    text: "text-orange-500 dark:text-orange-400",
    border: "border-orange-500/20",
    label: "Timed Out",
  },
  DEAD_LETTER: {
    dot: "bg-red-500",
    bg: "bg-red-500/10",
    text: "text-red-500 dark:text-red-400",
    border: "border-red-500/20",
    label: "Dead Letter",
  },
}

interface JobStatusBadgeProps {
  status: JobStatus
}

export function JobStatusBadge({ status }: JobStatusBadgeProps): React.JSX.Element {
  const style = statusStyles[status]

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${style.bg} ${style.text} ${style.border}`}
    >
      {status === "RETRYING" ? (
        <span className="material-symbols-outlined animate-spin text-[10px]">sync</span>
      ) : (
        <span className={`inline-block size-1.5 rounded-full ${style.dot}`} />
      )}
      {style.label}
    </span>
  )
}
