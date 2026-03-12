"use client"

import Link from "next/link"

import { ApiErrorBanner } from "@/components/layout/api-error-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { Skeleton } from "@/components/layout/skeleton"
import { useDashboard } from "@/hooks/use-dashboard"
import { relativeTime } from "@/lib/format"

const KIND_ICON: Record<string, string> = {
  job: "list_alt",
  approval: "verified_user",
  event: "info",
}

const KIND_COLOR: Record<string, string> = {
  job: "bg-primary/10 text-primary",
  approval: "bg-amber-500/10 text-amber-600",
  event: "bg-red-500/10 text-red-500",
}

export default function DashboardPage(): React.JSX.Element {
  const { stats, trends, recentJobs, activityEvents, isLoading, error, errorCode, refetch } =
    useDashboard()

  const cards = [
    {
      label: "Total Agents",
      value: stats.totalAgents,
      trend: trends.totalAgents24h,
      icon: "smart_toy",
      href: "/agents",
    },
    {
      label: "Active Jobs",
      value: stats.activeJobs,
      trend: trends.activeJobs24h,
      icon: "list_alt",
      href: "/jobs",
    },
    {
      label: "Pending Approvals",
      value: stats.pendingApprovals,
      trend: trends.pendingApprovals24h,
      icon: "verified_user",
      href: "/approvals",
    },
    {
      label: "Memory Records",
      value: stats.memoryRecords,
      trend: trends.memoryRecords24h,
      icon: "memory",
      href: "/memory",
    },
  ] as const

  const isNew =
    !isLoading &&
    stats.totalAgents === 0 &&
    stats.activeJobs === 0 &&
    activityEvents.length === 0 &&
    recentJobs.length === 0

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="material-symbols-outlined text-[28px] text-primary">dashboard</span>
        <h1 className="font-display text-2xl font-bold tracking-tight text-text-main">Dashboard</h1>
      </div>

      {/* Error banner */}
      {error && <ApiErrorBanner error={error} errorCode={errorCode} onRetry={refetch} />}

      {/* Empty state for brand-new users */}
      {isNew ? (
        <EmptyState
          icon="rocket_launch"
          title="Welcome to Cortex Plane"
          description="Deploy your first agent to get started. Once agents are running, you'll see KPIs, activity, and quick actions here."
          actionLabel="Deploy Agent"
          actionHref="/agents"
        />
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
            {cards.map(({ label, value, trend, icon, href }) => (
              <Link
                key={label}
                href={href}
                className="group min-h-[100px] rounded-xl border border-surface-border bg-surface-light p-6 transition-shadow hover:shadow-md"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                    {label}
                  </span>
                  <span className="material-symbols-outlined text-[20px] text-text-muted transition-colors group-hover:text-primary">
                    {icon}
                  </span>
                </div>
                {isLoading ? (
                  <Skeleton className="mt-2 h-9 w-16" />
                ) : (
                  <div className="mt-2 flex items-baseline gap-2">
                    <p className="text-3xl font-bold text-text-main">{value}</p>
                    {trend > 0 && (
                      <span className="flex items-center text-xs font-medium text-emerald-600">
                        <span className="material-symbols-outlined text-[14px]">trending_up</span>+
                        {trend}
                      </span>
                    )}
                    {trend === 0 && value > 0 && (
                      <span className="flex items-center text-xs font-medium text-text-muted">
                        <span className="material-symbols-outlined text-[14px]">trending_flat</span>
                      </span>
                    )}
                  </div>
                )}
                {!isLoading && trend > 0 && (
                  <p className="mt-1 text-[11px] text-text-muted">+{trend} in last 24h</p>
                )}
              </Link>
            ))}
          </div>

          {/* Quick actions */}
          <div className="flex flex-wrap gap-3">
            <Link
              href="/agents"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
            >
              <span className="material-symbols-outlined text-[18px]">add_circle</span>
              Deploy Agent
            </Link>
            {stats.pendingApprovals > 0 && (
              <Link
                href="/approvals"
                className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-700 transition-colors hover:bg-amber-100"
              >
                <span className="material-symbols-outlined text-[18px]">verified_user</span>
                View Pending Approvals
                <span className="rounded-full bg-amber-200 px-1.5 py-0.5 text-xs">
                  {stats.pendingApprovals}
                </span>
              </Link>
            )}
            <Link
              href="/jobs"
              className="inline-flex items-center gap-2 rounded-lg border border-surface-border bg-surface-light px-4 py-2.5 text-sm font-medium text-text-main transition-shadow hover:shadow-md"
            >
              <span className="material-symbols-outlined text-[18px]">list_alt</span>
              Browse Jobs
            </Link>
            <Link
              href="/pulse"
              className="inline-flex items-center gap-2 rounded-lg border border-surface-border bg-surface-light px-4 py-2.5 text-sm font-medium text-text-main transition-shadow hover:shadow-md"
            >
              <span className="material-symbols-outlined text-[18px]">hub</span>
              Content Pipeline
            </Link>
          </div>

          {/* Recent Activity */}
          <div>
            <h2 className="mb-4 font-display text-lg font-bold tracking-tight text-text-main">
              Recent Activity
            </h2>
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : activityEvents.length === 0 ? (
              <EmptyState
                icon="list_alt"
                title="No activity yet"
                description="Once agents begin executing tasks, recent activity will appear here."
                actionLabel="Go to Agents"
                actionHref="/agents"
              />
            ) : (
              <div className="rounded-xl border border-surface-border bg-surface-light overflow-hidden">
                <div className="divide-y divide-surface-border">
                  {activityEvents.map((evt) => (
                    <div key={evt.id} className="flex items-center gap-4 px-5 py-3.5">
                      <div
                        className={`flex size-9 shrink-0 items-center justify-center rounded-full ${KIND_COLOR[evt.kind] ?? "bg-primary/10 text-primary"}`}
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          {KIND_ICON[evt.kind] ?? "info"}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-text-main">
                          {evt.title}
                          <span className="ml-2 font-normal text-text-muted">
                            {evt.description}
                          </span>
                        </p>
                        <p className="text-xs text-text-muted">{relativeTime(evt.timestamp)}</p>
                      </div>
                      <span className="shrink-0 rounded-full border border-surface-border px-2 py-0.5 text-[11px] font-medium text-text-muted">
                        {evt.kind}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
