import type { JobStatus, JobSummary } from "@/lib/schemas/jobs"

export function generateMockJobs(): JobSummary[] {
  const statuses: JobStatus[] = [
    "COMPLETED",
    "COMPLETED",
    "COMPLETED",
    "FAILED",
    "RUNNING",
    "PENDING",
    "SCHEDULED",
    "RETRYING",
    "TIMED_OUT",
    "WAITING_FOR_APPROVAL",
    "DEAD_LETTER",
    "COMPLETED",
    "COMPLETED",
    "FAILED",
    "RUNNING",
    "COMPLETED",
    "COMPLETED",
    "COMPLETED",
    "FAILED",
    "COMPLETED",
    "RUNNING",
    "PENDING",
    "COMPLETED",
    "COMPLETED",
    "SCHEDULED",
  ]
  const types = ["inference", "tool-call", "pipeline", "batch", "scheduled"]
  const agents = ["agt-a1b2c3d4", "agt-e5f6g7h8", "agt-i9j0k1l2", "agt-m3n4o5p6", "agt-q7r8s9t0"]
  const now = Date.now()

  return statuses.map((status, i) => {
    const createdAt = new Date(now - (i + 1) * 1_800_000 - Math.random() * 3_600_000)
    const durationMs = 15_000 + Math.floor(Math.random() * 300_000)
    const completedAt =
      status === "RUNNING" || status === "PENDING" || status === "SCHEDULED"
        ? undefined
        : new Date(createdAt.getTime() + durationMs).toISOString()

    return {
      id: `job-${String(i + 1).padStart(4, "0")}-${Math.random().toString(36).slice(2, 10)}`,
      agentId: agents[i % agents.length]!,
      status,
      type: types[i % types.length]!,
      createdAt: createdAt.toISOString(),
      updatedAt: new Date(createdAt.getTime() + durationMs).toISOString(),
      completedAt,
      error:
        status === "FAILED"
          ? "Model inference timeout — upstream provider returned 504"
          : status === "DEAD_LETTER"
            ? "Max retry attempts exceeded (3/3)"
            : undefined,
    }
  })
}
