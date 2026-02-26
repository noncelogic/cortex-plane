export type PlanRunState = "PLANNED" | "RUNNING" | "BLOCKED" | "COMPLETED" | "FAILED"

export interface ExecutionPlanStep {
  id: string
  title: string
  description?: string
  depends_on?: string[]
  checkpoint_key?: string
  rollback_hint?: string
  approval_gate?: {
    required: boolean
    approver_roles?: string[]
    timeout_seconds?: number
  }
}

export interface ExecutionPlanDocument {
  schema_version: "v1"
  plan_id: string
  title: string
  metadata?: Record<string, unknown>
  steps: ExecutionPlanStep[]
}

export interface ExecutionPlanTimelineEvent {
  id: string
  planRunId: string
  fromState: PlanRunState | null
  toState: PlanRunState | null
  eventType: string
  stepId: string | null
  checkpointKey: string | null
  actor: string | null
  payload: Record<string, unknown>
  occurredAt: string
}
