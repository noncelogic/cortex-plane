import type { PlanRunState } from "@cortex/shared"
import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"

const TERMINAL: ReadonlySet<PlanRunState> = new Set(["COMPLETED", "FAILED"])

export interface ResumePoint {
  checkpointKey: string | null
  resumableStepId: string | null
  requiresApproval: boolean
}

export class ExecutionPlanService {
  constructor(private readonly db: Kysely<Database>) {}

  async timeline(planRunId: string) {
    const run = await this.db
      .selectFrom("execution_plan_run as run")
      .innerJoin("execution_plan_version as v", "v.id", "run.plan_version_id")
      .innerJoin("execution_plan as p", "p.id", "v.plan_id")
      .select([
        "run.id as runId",
        "run.state as runState",
        "run.current_step_id as currentStepId",
        "run.last_checkpoint_key as lastCheckpointKey",
        "run.approval_gate_step_id as approvalGateStepId",
        "run.approval_gate_status as approvalGateStatus",
        "run.blocked_reason as blockedReason",
        "run.created_at as runCreatedAt",
        "run.updated_at as runUpdatedAt",
        "v.id as planVersionId",
        "v.version_number as versionNumber",
        "v.plan_document as planDocument",
        "v.source_issue_number as sourceIssueNumber",
        "v.source_pr_number as sourcePrNumber",
        "v.source_agent_run_id as sourceAgentRunId",
        "v.source_job_id as sourceJobId",
        "v.source_session_id as sourceSessionId",
        "p.id as planId",
        "p.key as planKey",
        "p.title as planTitle",
      ])
      .where("run.id", "=", planRunId)
      .executeTakeFirst()

    if (!run) return null

    const events = await this.db
      .selectFrom("execution_plan_event")
      .selectAll()
      .where("plan_run_id", "=", planRunId)
      .orderBy("occurred_at", "asc")
      .execute()

    const resumePoint = this.computeResumePoint(run.runState, events)

    return {
      run,
      events,
      resumePoint,
    }
  }

  private computeResumePoint(
    state: PlanRunState,
    events: Array<{ checkpoint_key: string | null; step_id: string | null; event_type: string }>,
  ): ResumePoint {
    if (TERMINAL.has(state)) {
      return { checkpointKey: null, resumableStepId: null, requiresApproval: false }
    }

    const latestCheckpoint = [...events].reverse().find((e) => e.checkpoint_key)
    const waitingApproval = [...events]
      .reverse()
      .find((e) => e.event_type === "approval_requested" || e.event_type === "approval_granted")

    return {
      checkpointKey: latestCheckpoint?.checkpoint_key ?? null,
      resumableStepId: latestCheckpoint?.step_id ?? null,
      requiresApproval: waitingApproval?.event_type === "approval_requested",
    }
  }
}
