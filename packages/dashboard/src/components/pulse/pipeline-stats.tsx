import type { ContentPipelineStats } from "@/lib/api-client"
import { duration } from "@/lib/format"

interface StatCardProps {
  icon: string
  label: string
  value: string | number
  iconColor: string
  iconBg: string
}

function StatCard({ icon, label, value, iconColor, iconBg }: StatCardProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/50">
      <div className={`flex size-10 items-center justify-center rounded-lg ${iconBg}`}>
        <span className={`material-symbols-outlined text-xl ${iconColor}`}>{icon}</span>
      </div>
      <div>
        <p className="text-2xl font-bold text-text-main dark:text-white">{value}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      </div>
    </div>
  )
}

interface PipelineStatsProps {
  stats: ContentPipelineStats
}

export function PipelineStats({ stats }: PipelineStatsProps): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard
        icon="article"
        label="Total Pieces"
        value={stats.totalPieces}
        iconColor="text-blue-500"
        iconBg="bg-blue-50 dark:bg-blue-900/20"
      />
      <StatCard
        icon="publish"
        label="Published Today"
        value={stats.publishedToday}
        iconColor="text-emerald-500"
        iconBg="bg-emerald-50 dark:bg-emerald-900/20"
      />
      <StatCard
        icon="schedule"
        label="Avg Review Time"
        value={duration(stats.avgReviewTimeMs)}
        iconColor="text-amber-500"
        iconBg="bg-amber-50 dark:bg-amber-900/20"
      />
      <StatCard
        icon="pending_actions"
        label="Pending Review"
        value={stats.pendingReview}
        iconColor="text-purple-500"
        iconBg="bg-purple-50 dark:bg-purple-900/20"
      />
    </div>
  )
}
