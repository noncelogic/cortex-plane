import type { JobStatus } from "@/lib/schemas/jobs"

export interface DashboardStats {
  totalAgents: number
  activeJobs: number
  pendingApprovals: number
  memoryRecords: number
}

export interface RecentJob {
  id: string
  agentName: string
  status: JobStatus
  type: string
  createdAt: string
}

export function getDashboardStats(): DashboardStats {
  return {
    totalAgents: 5,
    activeJobs: 3,
    pendingApprovals: 7,
    memoryRecords: 8,
  }
}

export function getRecentJobs(): RecentJob[] {
  const now = Date.now()
  return [
    {
      id: "job-0001",
      agentName: "ContentBot",
      status: "RUNNING",
      type: "inference",
      createdAt: new Date(now - 300_000).toISOString(),
    },
    {
      id: "job-0002",
      agentName: "DigestAgent",
      status: "COMPLETED",
      type: "pipeline",
      createdAt: new Date(now - 1_800_000).toISOString(),
    },
    {
      id: "job-0003",
      agentName: "SocialPulse",
      status: "WAITING_FOR_APPROVAL",
      type: "tool-call",
      createdAt: new Date(now - 3_600_000).toISOString(),
    },
    {
      id: "job-0004",
      agentName: "AnalyticsBot",
      status: "FAILED",
      type: "batch",
      createdAt: new Date(now - 7_200_000).toISOString(),
    },
    {
      id: "job-0005",
      agentName: "ContentBot",
      status: "COMPLETED",
      type: "scheduled",
      createdAt: new Date(now - 14_400_000).toISOString(),
    },
  ]
}
