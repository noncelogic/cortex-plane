"use client"

import { useCallback, useMemo, useState } from "react"

import { JobDetailDrawer } from "@/components/jobs/job-detail-drawer"
import { JobStatusBadge } from "@/components/jobs/job-status-badge"
import { useApi, useApiQuery } from "@/hooks/use-api"
import type { CreateAgentJobRequest, JobSummary } from "@/lib/api-client"
import { createAgentJob, listJobs } from "@/lib/api-client"
import { duration, relativeTime, truncateUuid } from "@/lib/format"

interface AgentJobsTabProps {
  agentId: string
}

export function AgentJobsTab({ agentId }: AgentJobsTabProps): React.JSX.Element {
  const { data, isLoading, error, refetch } = useApiQuery(
    () => listJobs({ agent_id: agentId, limit: 50 }),
    [agentId],
  )

  const jobs: JobSummary[] = useMemo(() => data?.jobs ?? [], [data])

  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const {
    execute: execCreate,
    isLoading: creating,
    error: createError,
  } = useApi(createAgentJob as (...args: unknown[]) => Promise<unknown>)
  const [createSuccess, setCreateSuccess] = useState(false)

  const handleCreateJob = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!prompt.trim() || creating) return
      const body: CreateAgentJobRequest = { prompt: prompt.trim() }
      const result = await execCreate(agentId, body)
      if (result) {
        setPrompt("")
        setCreateSuccess(true)
        void refetch()
        setTimeout(() => setCreateSuccess(false), 3000)
      }
    },
    [agentId, prompt, creating, execCreate, refetch],
  )

  return (
    <div className="space-y-6">
      {/* Create Job form */}
      <div className="rounded-xl border border-surface-border bg-surface-light p-5">
        <div className="mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">add_task</span>
          <h3 className="text-xs font-bold uppercase tracking-widest text-text-muted">
            Create Job
          </h3>
        </div>
        <form onSubmit={(e) => void handleCreateJob(e)} className="space-y-3">
          <textarea
            value={prompt}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPrompt(e.target.value)}
            placeholder="Describe the task for this agent..."
            rows={3}
            disabled={creating}
            className="w-full resize-none rounded-lg border border-surface-border bg-bg-light p-3 text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <button
            type="submit"
            disabled={creating || !prompt.trim()}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[18px]">
              {creating ? "sync" : "play_arrow"}
            </span>
            {creating ? "Creating..." : "Create Job"}
          </button>
          {createSuccess && (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-500">
              <span className="material-symbols-outlined text-[16px]">check_circle</span>
              Job created successfully
            </div>
          )}
          {createError && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-500">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {createError}
            </div>
          )}
        </form>
      </div>

      {/* Job list */}
      <div className="rounded-xl border border-surface-border bg-surface-light">
        <div className="flex items-center justify-between border-b border-surface-border p-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">list_alt</span>
            <h3 className="text-xs font-bold uppercase tracking-widest text-text-muted">
              Job History
            </h3>
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-secondary hover:text-primary"
            title="Refresh"
          >
            <span className="material-symbols-outlined text-lg">refresh</span>
          </button>
        </div>

        {isLoading && jobs.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <span className="material-symbols-outlined animate-spin text-2xl text-text-muted">
              sync
            </span>
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-sm text-text-muted">{error}</div>
        ) : jobs.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <span className="material-symbols-outlined mb-2 text-3xl text-text-muted">
              work_history
            </span>
            <p className="text-sm text-text-muted">No jobs for this agent yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-surface-border">
            {jobs.map((job) => {
              const durationMs =
                job.completed_at && job.created_at
                  ? new Date(job.completed_at).getTime() - new Date(job.created_at).getTime()
                  : null
              return (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => setSelectedJobId(job.id)}
                  className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-primary/5"
                >
                  <span className="font-mono text-xs font-bold text-primary">
                    {truncateUuid(job.id)}
                  </span>
                  <JobStatusBadge status={job.status} />
                  <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-text-muted">
                    {job.type}
                  </span>
                  <span className="ml-auto font-mono text-xs text-text-muted">
                    {durationMs !== null ? duration(durationMs) : "—"}
                  </span>
                  <span className="text-xs text-text-muted">{relativeTime(job.created_at)}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Detail Drawer */}
      <JobDetailDrawer
        jobId={selectedJobId}
        onClose={() => setSelectedJobId(null)}
        onRetried={() => void refetch()}
      />
    </div>
  )
}
