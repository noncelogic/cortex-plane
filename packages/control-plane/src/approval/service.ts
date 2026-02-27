/**
 * ApprovalService — core approval gate logic.
 *
 * Responsibilities:
 * - Create approval requests (generate token, persist hash, set TTL)
 * - Validate and process approval/rejection decisions
 * - Expire stale requests
 * - Write audit log entries
 * - Coordinate with Graphile Worker for job resume on approval
 *
 * All approval state lives in PostgreSQL. The service is stateless.
 */

import type { Kysely } from "kysely"
import type { WorkerUtils } from "graphile-worker"

import {
  DEFAULT_APPROVAL_TTL_SECONDS,
  MAX_APPROVAL_TTL_SECONDS,
  type ApprovalAuditEventType,
  type ApprovalNotificationRecord,
  type ApprovalStatus,
  type CreateApprovalRequest,
  type ApprovalDecisionResult,
} from "@cortex/shared"
import { withSpan, CortexAttributes } from "@cortex/shared/tracing"
import type { Database, ApprovalRequest, ApprovalAuditLog } from "../db/types.js"
import { generateApprovalToken, hashApprovalToken, isValidTokenFormat } from "./token.js"
import { createAuditEntry, type AuditActorMetadata, type AuditEntry } from "./audit.js"

export interface ApprovalServiceDeps {
  db: Kysely<Database>
  workerUtils?: WorkerUtils
}

export interface CreatedApproval {
  /** Database row ID */
  approvalRequestId: string
  /** Plaintext token (for notifications — do NOT persist) */
  plaintextToken: string
  /** When the request expires */
  expiresAt: Date
}

export class ApprovalService {
  private readonly db: Kysely<Database>
  private readonly workerUtils?: WorkerUtils

  constructor(deps: ApprovalServiceDeps) {
    this.db = deps.db
    this.workerUtils = deps.workerUtils
  }

  /**
   * Create a new approval request.
   *
   * 1. Generates a 256-bit token and stores its SHA-256 hash
   * 2. Creates the approval_request row
   * 3. Transitions the job to WAITING_FOR_APPROVAL
   * 4. Returns the plaintext token for sending in notifications
   */
  async createRequest(req: CreateApprovalRequest): Promise<CreatedApproval> {
    return withSpan("cortex.approval.create", async (span) => {
      span.setAttribute(CortexAttributes.JOB_ID, req.jobId)
      span.setAttribute(CortexAttributes.AGENT_ID, req.agentId)
      const { plaintext, hash } = generateApprovalToken()

      const ttlSeconds = Math.min(
        req.ttlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS,
        MAX_APPROVAL_TTL_SECONDS,
      )
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

      let approvalRequestId: string | undefined

      await this.db.transaction().execute(async (tx) => {
        // Insert approval_request
        const inserted = await tx
          .insertInto("approval_request")
          .values({
            job_id: req.jobId,
            action_type: req.actionType,
            action_summary: req.actionSummary,
            action_detail: req.actionDetail,
            token_hash: hash,
            expires_at: expiresAt,
            requested_by_agent_id: req.agentId,
            approver_user_account_id: req.approverUserAccountId ?? null,
          })
          .returning("id")
          .executeTakeFirstOrThrow()

        approvalRequestId = inserted.id

        // Transition job: RUNNING → WAITING_FOR_APPROVAL
        await tx
          .updateTable("job")
          .set({
            status: "WAITING_FOR_APPROVAL" as const,
            approval_expires_at: expiresAt,
          })
          .where("id", "=", req.jobId)
          .where("status", "=", "RUNNING")
          .execute()
      })

      // Audit log (outside transaction for speed)
      await this.writeAuditLog({
        approvalRequestId: approvalRequestId!,
        jobId: req.jobId,
        eventType: "request_created",
        details: {
          action_type: req.actionType,
          action_summary: req.actionSummary,
          ttl_seconds: ttlSeconds,
          expires_at: expiresAt.toISOString(),
        },
      })

      return {
        approvalRequestId: approvalRequestId!,
        plaintextToken: plaintext,
        expiresAt,
      }
    }) // end withSpan
  }

  /**
   * Process an approval or rejection decision.
   *
   * For approvals: marks request as APPROVED, transitions job to RUNNING,
   * and enqueues a Graphile Worker task to resume agent execution.
   *
   * For rejections: marks request as REJECTED, transitions job to FAILED.
   *
   * Uses atomic UPDATE ... WHERE status = 'PENDING' for single-use enforcement.
   */
  async decide(
    approvalRequestId: string,
    decision: "APPROVED" | "REJECTED",
    decidedBy: string,
    channel: string,
    reason?: string,
    actorMetadata?: AuditActorMetadata,
  ): Promise<ApprovalDecisionResult> {
    return withSpan("cortex.approval.decide", async (span) => {
      span.setAttribute(CortexAttributes.APPROVAL_REQUEST_ID, approvalRequestId)
      span.setAttribute(CortexAttributes.APPROVAL_DECISION, decision)
      // Fetch the request
      const request = await this.db
        .selectFrom("approval_request")
        .selectAll()
        .where("id", "=", approvalRequestId)
        .executeTakeFirst()

      if (!request) {
        return { success: false, error: "not_found" }
      }

      if (request.status !== "PENDING") {
        return { success: false, error: "already_decided" }
      }

      if (request.expires_at < new Date()) {
        return { success: false, error: "expired" }
      }

      // Check authorization: if a specific approver is designated, only they can decide
      if (
        request.approver_user_account_id !== null &&
        request.approver_user_account_id !== decidedBy
      ) {
        await this.writeAuditLog({
          approvalRequestId,
          jobId: request.job_id,
          eventType: "unauthorized_attempt",
          actorUserId: decidedBy,
          actorChannel: channel,
          details: { attempted_action: decision },
        })
        return { success: false, error: "not_authorized" }
      }

      let jobId: string | undefined

      await this.db.transaction().execute(async (tx) => {
        // Atomic single-use: only update if still PENDING
        const updated = await tx
          .updateTable("approval_request")
          .set({
            status: decision,
            decided_at: new Date(),
            decided_by: decidedBy,
            decision_note: reason ?? null,
          })
          .where("id", "=", approvalRequestId)
          .where("status", "=", "PENDING")
          .executeTakeFirst()

        if (!updated.numUpdatedRows || updated.numUpdatedRows === 0n) {
          throw new Error("approval_already_decided")
        }

        jobId = request.job_id

        if (decision === "APPROVED") {
          // Transition job: WAITING_FOR_APPROVAL → RUNNING
          await tx
            .updateTable("job")
            .set({
              status: "RUNNING" as const,
              approval_expires_at: null,
            })
            .where("id", "=", request.job_id)
            .where("status", "=", "WAITING_FOR_APPROVAL")
            .execute()
        } else {
          // Transition job: WAITING_FOR_APPROVAL → FAILED
          const errorMessage = reason
            ? `Approval rejected by ${decidedBy}: ${reason}`
            : `Approval rejected by ${decidedBy}`

          await tx
            .updateTable("job")
            .set({
              status: "FAILED" as const,
              approval_expires_at: null,
              error: { message: errorMessage },
              completed_at: new Date(),
            })
            .where("id", "=", request.job_id)
            .where("status", "=", "WAITING_FOR_APPROVAL")
            .execute()
        }
      })

      // Enqueue agent resume outside transaction
      if (decision === "APPROVED" && this.workerUtils && jobId) {
        await this.workerUtils.addJob("agent_execute", { jobId }, { maxAttempts: 1 })
      }

      // Audit log with chained hash for tamper evidence
      const auditDetails: Record<string, unknown> = {
        decision,
        reason: reason ?? null,
      }
      if (actorMetadata) {
        auditDetails.actor = actorMetadata

        // Build chained audit entry
        const previousHash = await this.getLastAuditHash(approvalRequestId)
        const auditEntry = createAuditEntry(
          approvalRequestId,
          decision,
          actorMetadata,
          previousHash,
        )
        auditDetails.entry_hash = auditEntry.entryHash
        auditDetails.previous_hash = auditEntry.previousHash
      }

      await this.writeAuditLog({
        approvalRequestId,
        jobId: request.job_id,
        eventType: "request_decided",
        actorUserId: decidedBy,
        actorChannel: channel,
        details: auditDetails,
      })

      return {
        success: true,
        approvalRequestId,
        decision,
      }
    }) // end withSpan
  }

  /**
   * Process a decision using a plaintext approval token.
   * Used for REST API token-based approval (spike #26 flow).
   */
  async decideByToken(
    plaintextToken: string,
    decision: "APPROVED" | "REJECTED",
    decidedBy: string,
    channel: string,
    reason?: string,
    actorMetadata?: AuditActorMetadata,
  ): Promise<ApprovalDecisionResult> {
    if (!isValidTokenFormat(plaintextToken)) {
      return { success: false, error: "invalid_token_format" }
    }

    const tokenHash = hashApprovalToken(plaintextToken)

    const request = await this.db
      .selectFrom("approval_request")
      .select("id")
      .where("token_hash", "=", tokenHash)
      .where("status", "=", "PENDING")
      .executeTakeFirst()

    if (!request) {
      return { success: false, error: "not_found" }
    }

    return this.decide(request.id, decision, decidedBy, channel, reason, actorMetadata)
  }

  /**
   * Expire stale approval requests.
   * Called by the Graphile Worker cron task.
   *
   * Finds all PENDING requests past their expires_at and transitions them
   * to EXPIRED, failing their associated jobs.
   */
  async expireStaleRequests(): Promise<number> {
    const now = new Date()

    // Find all expired pending requests
    const expiredRequests = await this.db
      .selectFrom("approval_request")
      .select(["id", "job_id"])
      .where("status", "=", "PENDING")
      .where("expires_at", "<", now)
      .execute()

    for (const req of expiredRequests) {
      await this.db.transaction().execute(async (tx) => {
        // Mark request as expired (only if still PENDING)
        const updated = await tx
          .updateTable("approval_request")
          .set({
            status: "EXPIRED" as ApprovalStatus,
            decided_at: now,
          })
          .where("id", "=", req.id)
          .where("status", "=", "PENDING")
          .executeTakeFirst()

        if (!updated.numUpdatedRows || updated.numUpdatedRows === 0n) {
          return // Already decided by another process
        }

        // Fail the job
        await tx
          .updateTable("job")
          .set({
            status: "FAILED" as const,
            approval_expires_at: null,
            error: { message: "Approval request expired" },
            completed_at: now,
          })
          .where("id", "=", req.job_id)
          .where("status", "=", "WAITING_FOR_APPROVAL")
          .execute()
      })

      await this.writeAuditLog({
        approvalRequestId: req.id,
        jobId: req.job_id,
        eventType: "request_expired",
        details: { expired_at: now.toISOString() },
      })
    }

    return expiredRequests.length
  }

  /**
   * Record that a notification was sent for an approval request.
   * Updates the notification_channels JSONB array on the approval_request row.
   */
  async recordNotification(
    approvalRequestId: string,
    notification: ApprovalNotificationRecord,
  ): Promise<void> {
    // Read current channels, append, write back
    const request = await this.db
      .selectFrom("approval_request")
      .select(["id", "job_id", "notification_channels"])
      .where("id", "=", approvalRequestId)
      .executeTakeFirst()

    if (!request) return

    const channels = Array.isArray(request.notification_channels)
      ? [...request.notification_channels, notification]
      : [notification]

    await this.db
      .updateTable("approval_request")
      .set({ notification_channels: channels as Record<string, unknown>[] })
      .where("id", "=", approvalRequestId)
      .execute()

    await this.writeAuditLog({
      approvalRequestId,
      jobId: request.job_id,
      eventType: "notification_sent",
      details: {
        channel_type: notification.channel_type,
        channel_user_id: notification.channel_user_id,
        chat_id: notification.chat_id,
        message_id: notification.message_id,
      },
    })
  }

  /**
   * Get a single approval request by ID.
   */
  async getRequest(approvalRequestId: string): Promise<ApprovalRequest | undefined> {
    return this.db
      .selectFrom("approval_request")
      .selectAll()
      .where("id", "=", approvalRequestId)
      .executeTakeFirst()
  }

  /**
   * Get pending approval requests for a job.
   */
  async getPendingForJob(jobId: string): Promise<ApprovalRequest[]> {
    return this.db
      .selectFrom("approval_request")
      .selectAll()
      .where("job_id", "=", jobId)
      .where("status", "=", "PENDING")
      .orderBy("requested_at", "desc")
      .execute()
  }

  /**
   * List approval requests with optional filters.
   */
  async list(filters?: {
    status?: ApprovalStatus
    jobId?: string
    approverUserId?: string
    limit?: number
    offset?: number
  }): Promise<ApprovalRequest[]> {
    let query = this.db.selectFrom("approval_request").selectAll()

    if (filters?.status) {
      query = query.where("status", "=", filters.status)
    }
    if (filters?.jobId) {
      query = query.where("job_id", "=", filters.jobId)
    }
    if (filters?.approverUserId) {
      query = query.where("approver_user_account_id", "=", filters.approverUserId)
    }

    query = query.orderBy("requested_at", "desc").limit(filters?.limit ?? 50)

    if (filters?.offset) {
      query = query.offset(filters.offset)
    }

    return query.execute()
  }

  /**
   * Get the audit trail for an approval request.
   * Returns all audit log entries ordered chronologically.
   */
  async getAuditTrail(approvalRequestId: string): Promise<ApprovalAuditLog[]> {
    return this.db
      .selectFrom("approval_audit_log")
      .selectAll()
      .where("approval_request_id", "=", approvalRequestId)
      .orderBy("created_at", "asc")
      .execute()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Get the hash from the last audit entry for chaining.
   */
  private async getLastAuditHash(approvalRequestId: string): Promise<string | null> {
    try {
      const last = await this.db
        .selectFrom("approval_audit_log")
        .select("details")
        .where("approval_request_id", "=", approvalRequestId)
        .orderBy("created_at", "desc")
        .executeTakeFirst()

      if (last?.details && typeof last.details === "object") {
        const hash = (last.details as Record<string, unknown>).entry_hash
        if (typeof hash === "string") return hash
      }
    } catch {
      // Non-fatal
    }
    return null
  }

  private async writeAuditLog(entry: {
    approvalRequestId: string
    jobId: string
    eventType: ApprovalAuditEventType
    actorUserId?: string
    actorChannel?: string
    details: Record<string, unknown>
  }): Promise<void> {
    try {
      await this.db
        .insertInto("approval_audit_log")
        .values({
          approval_request_id: entry.approvalRequestId,
          job_id: entry.jobId,
          event_type: entry.eventType,
          actor_user_id: entry.actorUserId ?? null,
          actor_channel: entry.actorChannel ?? null,
          details: entry.details,
        })
        .execute()
    } catch {
      // Audit log failures are non-fatal — log but don't throw
      // In production, Pino would capture this
    }
  }
}
