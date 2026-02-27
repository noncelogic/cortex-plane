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

import {
  MAX_APPROVAL_TTL_SECONDS,
  type ApprovalAuditEventType,
  type ApprovalDecisionResult,
  type ApprovalNotificationRecord,
  type ApprovalStatus,
  type CreateApprovalRequest,
  type RiskLevel,
} from "@cortex/shared"
import { CortexAttributes, withSpan } from "@cortex/shared/tracing"
import type { WorkerUtils } from "graphile-worker"
import type { Kysely } from "kysely"

import type { ApprovalAuditLog, ApprovalRequest, Database } from "../db/types.js"
import { type AuditActorMetadata, createAuditEntry } from "./audit.js"
import { generateApprovalToken, hashApprovalToken, isValidTokenFormat } from "./token.js"

export interface ApprovalServiceDeps {
  db: Kysely<Database>
  workerUtils?: WorkerUtils
}

export interface CreatedApproval {
  approvalRequestId: string
  plaintextToken: string
  expiresAt: Date
  riskLevel: RiskLevel
  autoApprovable: boolean
  shouldNotify: boolean
}

const DEFAULT_TTL_BY_RISK: Record<RiskLevel, number> = {
  P0: 86_400,
  P1: 86_400,
  P2: 259_200,
  P3: 259_200,
}

export class ApprovalService {
  private readonly db: Kysely<Database>
  private readonly workerUtils?: WorkerUtils

  constructor(deps: ApprovalServiceDeps) {
    this.db = deps.db
    this.workerUtils = deps.workerUtils
  }

  async createRequest(req: CreateApprovalRequest): Promise<CreatedApproval> {
    return withSpan("cortex.approval.create", async (span) => {
      span.setAttribute(CortexAttributes.JOB_ID, req.jobId)
      span.setAttribute(CortexAttributes.AGENT_ID, req.agentId)

      const riskLevel = req.riskLevel ?? "P2"
      const autoApprovable = riskLevel === "P3"
      const shouldNotify = riskLevel === "P0" || riskLevel === "P1" || (riskLevel === "P2" && !autoApprovable)

      const { plaintext, hash } = generateApprovalToken()
      const defaultTtl = DEFAULT_TTL_BY_RISK[riskLevel]
      const ttlSeconds = Math.min(req.ttlSeconds ?? defaultTtl, MAX_APPROVAL_TTL_SECONDS)
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000)

      let approvalRequestId: string | undefined

      await this.db.transaction().execute(async (tx) => {
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
            risk_level: riskLevel,
            resume_payload: req.resumePayload ?? null,
            blast_radius: req.blastRadius ?? null,
            status: autoApprovable ? "APPROVED" : "PENDING",
            decided_at: autoApprovable ? new Date() : null,
            decided_by: autoApprovable ? "policy:auto" : null,
            decision_note: autoApprovable ? "Auto-approved by policy (P3)" : null,
          })
          .returning("id")
          .executeTakeFirstOrThrow()

        approvalRequestId = inserted.id

        await tx
          .updateTable("job")
          .set(
            autoApprovable
              ? { status: "RUNNING" as const, approval_expires_at: null }
              : { status: "WAITING_FOR_APPROVAL" as const, approval_expires_at: expiresAt },
          )
          .where("id", "=", req.jobId)
          .where("status", "=", "RUNNING")
          .execute()
      })

      await this.writeAuditLog({
        approvalRequestId: approvalRequestId!,
        jobId: req.jobId,
        eventType: autoApprovable ? "request_decided" : "request_created",
        details: {
          action_type: req.actionType,
          action_summary: req.actionSummary,
          ttl_seconds: ttlSeconds,
          expires_at: expiresAt.toISOString(),
          risk_level: riskLevel,
          auto_approvable: autoApprovable,
          should_notify: shouldNotify,
        },
      })

      if (autoApprovable && this.workerUtils) {
        await this.workerUtils.addJob("agent_execute", { jobId: req.jobId }, { maxAttempts: 1 })
      }

      return {
        approvalRequestId: approvalRequestId!,
        plaintextToken: plaintext,
        expiresAt,
        riskLevel,
        autoApprovable,
        shouldNotify,
      }
    })
  }

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

      const request = await this.db
        .selectFrom("approval_request")
        .selectAll()
        .where("id", "=", approvalRequestId)
        .executeTakeFirst()

      if (!request) return { success: false, error: "not_found" }
      if (request.status !== "PENDING") return { success: false, error: "already_decided" }
      if (request.expires_at < new Date()) return { success: false, error: "expired" }

      if (request.approver_user_account_id !== null && request.approver_user_account_id !== decidedBy) {
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
          await tx
            .updateTable("job")
            .set({ status: "RUNNING" as const, approval_expires_at: null })
            .where("id", "=", request.job_id)
            .where("status", "=", "WAITING_FOR_APPROVAL")
            .execute()
        } else {
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

      if (decision === "APPROVED" && this.workerUtils && jobId) {
        await this.workerUtils.addJob("agent_execute", { jobId }, { maxAttempts: 1 })
      }

      const auditDetails: Record<string, unknown> = { decision, reason: reason ?? null }
      if (actorMetadata) {
        auditDetails.actor = actorMetadata
        const previousHash = await this.getLastAuditHash(approvalRequestId)
        const auditEntry = createAuditEntry(approvalRequestId, decision, actorMetadata, previousHash)
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

      return { success: true, approvalRequestId, decision }
    })
  }

  async decideByToken(
    plaintextToken: string,
    decision: "APPROVED" | "REJECTED",
    decidedBy: string,
    channel: string,
    reason?: string,
    actorMetadata?: AuditActorMetadata,
  ): Promise<ApprovalDecisionResult> {
    if (!isValidTokenFormat(plaintextToken)) return { success: false, error: "invalid_token_format" }

    const tokenHash = hashApprovalToken(plaintextToken)
    const request = await this.db
      .selectFrom("approval_request")
      .select("id")
      .where("token_hash", "=", tokenHash)
      .where("status", "=", "PENDING")
      .executeTakeFirst()

    if (!request) return { success: false, error: "not_found" }
    return this.decide(request.id, decision, decidedBy, channel, reason, actorMetadata)
  }

  async resumeApproval(approvalRequestId: string): Promise<{ proposal: ApprovalRequest; resumePayload: Record<string, unknown> | null } | null> {
    const request = await this.getRequest(approvalRequestId)
    if (!request || request.status !== "APPROVED") return null

    await this.db
      .updateTable("approval_request")
      .set({ resumed_at: new Date() })
      .where("id", "=", approvalRequestId)
      .execute()

    return {
      proposal: request,
      resumePayload: (request.resume_payload as Record<string, unknown> | null) ?? null,
    }
  }

  async recordExecution(approvalRequestId: string, executionResult: Record<string, unknown>): Promise<void> {
    await this.db
      .updateTable("approval_request")
      .set({
        executed_at: new Date(),
        execution_result: executionResult,
      })
      .where("id", "=", approvalRequestId)
      .execute()
  }

  async expireStaleRequests(): Promise<number> {
    const now = new Date()
    const expiredRequests = await this.db
      .selectFrom("approval_request")
      .select(["id", "job_id"])
      .where("status", "=", "PENDING")
      .where("expires_at", "<", now)
      .execute()

    for (const req of expiredRequests) {
      await this.db.transaction().execute(async (tx) => {
        const updated = await tx
          .updateTable("approval_request")
          .set({ status: "EXPIRED" as ApprovalStatus, decided_at: now })
          .where("id", "=", req.id)
          .where("status", "=", "PENDING")
          .executeTakeFirst()

        if (!updated.numUpdatedRows || updated.numUpdatedRows === 0n) return

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

  async recordNotification(approvalRequestId: string, notification: ApprovalNotificationRecord): Promise<void> {
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

  async shouldNotify(approvalRequestId: string): Promise<boolean> {
    const req = await this.db
      .selectFrom("approval_request")
      .select(["risk_level"])
      .where("id", "=", approvalRequestId)
      .executeTakeFirst()
    if (!req) return false
    if (req.risk_level === "P3") return false
    return true
  }

  async getRequest(approvalRequestId: string): Promise<ApprovalRequest | undefined> {
    return this.db.selectFrom("approval_request").selectAll().where("id", "=", approvalRequestId).executeTakeFirst()
  }

  async getPendingForJob(jobId: string): Promise<ApprovalRequest[]> {
    return this.db
      .selectFrom("approval_request")
      .selectAll()
      .where("job_id", "=", jobId)
      .where("status", "=", "PENDING")
      .orderBy("requested_at", "desc")
      .execute()
  }

  async list(filters?: {
    status?: ApprovalStatus
    jobId?: string
    approverUserId?: string
    limit?: number
    offset?: number
  }): Promise<ApprovalRequest[]> {
    let query = this.db.selectFrom("approval_request").selectAll()
    if (filters?.status) query = query.where("status", "=", filters.status)
    if (filters?.jobId) query = query.where("job_id", "=", filters.jobId)
    if (filters?.approverUserId) query = query.where("approver_user_account_id", "=", filters.approverUserId)
    query = query.orderBy("requested_at", "desc").limit(filters?.limit ?? 50)
    if (filters?.offset) query = query.offset(filters.offset)
    return query.execute()
  }

  async getAuditTrail(approvalRequestId: string): Promise<ApprovalAuditLog[]> {
    return this.db
      .selectFrom("approval_audit_log")
      .selectAll()
      .where("approval_request_id", "=", approvalRequestId)
      .orderBy("created_at", "asc")
      .execute()
  }

  private async getLastAuditHash(approvalRequestId: string): Promise<string | null> {
    try {
      const last = await this.db
        .selectFrom("approval_audit_log")
        .select("details")
        .where("approval_request_id", "=", approvalRequestId)
        .orderBy("created_at", "desc")
        .executeTakeFirst()
      if (last?.details && typeof last.details === "object") {
        const hash = last.details.entry_hash
        if (typeof hash === "string") return hash
      }
    } catch {}
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
    } catch {}
  }
}
