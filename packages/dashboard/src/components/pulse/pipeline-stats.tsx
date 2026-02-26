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
    <div className="flex items-center gap-4 rounded-xl border border-surface-border bg-surface-light p-4 shadow-sm">
      <div className={`flex size-10 items-center justify-center rounded-lg ${iconBg}`}>
        <span className={`material-symbols-outlined text-xl ${iconColor}`}>{icon}</span>
      </div>
      <div>
        <p className="text-2xl font-bold text-text-main">{value}</p>
        <p className="text-xs text-text-muted">{label}</p>
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
        iconBg="bg-blue-500/10"
      />
      <StatCard
        icon="publish"
        label="Published Today"
        value={stats.publishedToday}
        iconColor="text-emerald-500"
        iconBg="bg-emerald-500/10"
      />
      <StatCard
        icon="schedule"
        label="Avg Review Time"
        value={duration(stats.avgReviewTimeMs)}
        iconColor="text-amber-500"
        iconBg="bg-amber-500/10"
      />
      <StatCard
        icon="pending_actions"
        label="Pending Review"
        value={stats.pendingReview}
        iconColor="text-purple-500"
        iconBg="bg-purple-500/10"
      />
    </div>
  )
}
