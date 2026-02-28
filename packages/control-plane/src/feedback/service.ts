import type {
  FeedbackActionStatus,
  FeedbackActionType,
  FeedbackCategory,
  FeedbackSeverity,
  FeedbackSource,
  FeedbackStatus,
  RemediationStatus,
} from "@cortex/shared"
import type { Kysely } from "kysely"

import type { Database, FeedbackAction, FeedbackItem } from "../db/types.js"

export interface FeedbackServiceDeps {
  db: Kysely<Database>
}

export interface CreateFeedbackInput {
  runId?: string | null
  taskId?: string | null
  agentId?: string | null
  source: FeedbackSource
  category: FeedbackCategory
  severity: FeedbackSeverity
  summary: string
  details?: Record<string, unknown>
  recurrenceKey?: string | null
}

export interface UpdateRemediationInput {
  status?: FeedbackStatus
  remediationStatus?: RemediationStatus
  remediationNotes?: string | null
  resolvedAt?: Date | null
}

const severityRank: Record<FeedbackSeverity, number> = { low: 1, medium: 2, high: 3 }
const rankedSeverity: FeedbackSeverity[] = ["low", "medium", "high"]

export class FeedbackService {
  private readonly db: Kysely<Database>

  constructor(deps: FeedbackServiceDeps) {
    this.db = deps.db
  }

  async createFeedback(input: CreateFeedbackInput): Promise<FeedbackItem> {
    const existing = input.recurrenceKey
      ? await this.db
          .selectFrom("feedback_item")
          .select(["severity"])
          .where("recurrence_key", "=", input.recurrenceKey)
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirst()
      : undefined

    let severity = input.severity
    if (existing) {
      const escalatedRank = Math.min(3, severityRank[existing.severity] + 1)
      severity = rankedSeverity[escalatedRank - 1] as FeedbackSeverity
    }

    return this.db
      .insertInto("feedback_item")
      .values({
        run_id: input.runId ?? null,
        task_id: input.taskId ?? null,
        agent_id: input.agentId ?? null,
        source: input.source,
        category: input.category,
        severity,
        summary: input.summary,
        details: input.details ?? {},
        recurrence_key: input.recurrenceKey ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async getFeedback(id: string): Promise<FeedbackItem | undefined> {
    return this.db.selectFrom("feedback_item").selectAll().where("id", "=", id).executeTakeFirst()
  }

  async listFeedback(filters?: {
    status?: FeedbackStatus
    remediationStatus?: RemediationStatus
    severity?: FeedbackSeverity
    limit?: number
    offset?: number
  }): Promise<FeedbackItem[]> {
    let q = this.db.selectFrom("feedback_item").selectAll()
    if (filters?.status) q = q.where("status", "=", filters.status)
    if (filters?.remediationStatus)
      q = q.where("remediation_status", "=", filters.remediationStatus)
    if (filters?.severity) q = q.where("severity", "=", filters.severity)
    q = q.orderBy("created_at", "desc").limit(filters?.limit ?? 50)
    if (filters?.offset) q = q.offset(filters.offset)
    return q.execute()
  }

  async updateRemediation(
    id: string,
    input: UpdateRemediationInput,
  ): Promise<FeedbackItem | undefined> {
    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (input.status !== undefined) patch.status = input.status
    if (input.remediationStatus !== undefined) patch.remediation_status = input.remediationStatus
    if (input.remediationNotes !== undefined) patch.remediation_notes = input.remediationNotes
    if (input.resolvedAt !== undefined) patch.resolved_at = input.resolvedAt

    return this.db
      .updateTable("feedback_item")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  async addAction(input: {
    feedbackId: string
    actionType: FeedbackActionType
    actionRef?: string | null
    description?: string | null
    status?: FeedbackActionStatus
  }): Promise<FeedbackAction> {
    return this.db
      .insertInto("feedback_action")
      .values({
        feedback_id: input.feedbackId,
        action_type: input.actionType,
        action_ref: input.actionRef ?? null,
        description: input.description ?? null,
        status: input.status ?? "planned",
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async getActions(feedbackId: string): Promise<FeedbackAction[]> {
    return this.db
      .selectFrom("feedback_action")
      .selectAll()
      .where("feedback_id", "=", feedbackId)
      .orderBy("created_at", "asc")
      .execute()
  }
}
