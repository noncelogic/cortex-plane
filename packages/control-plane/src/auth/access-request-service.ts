import type { Kysely } from "kysely"

import type { AccessRequest, AgentUserGrant, Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class AccessRequestConflictError extends Error {
  readonly statusCode = 409

  constructor(message: string) {
    super(message)
    this.name = "AccessRequestConflictError"
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "23505"
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AccessRequestService {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Create a pending access request.
   * If a pending request already exists for the same agent+user, returns it
   * (idempotent).
   */
  async create(
    agentId: string,
    userAccountId: string,
    channelMappingId: string,
    messagePreview?: string,
  ): Promise<AccessRequest> {
    try {
      return await this.db
        .insertInto("access_request")
        .values({
          agent_id: agentId,
          user_account_id: userAccountId,
          channel_mapping_id: channelMappingId,
          message_preview: messagePreview ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    } catch (err: unknown) {
      if (!isUniqueViolation(err)) throw err

      // Return the existing pending request (idempotent)
      const existing = await this.db
        .selectFrom("access_request")
        .selectAll()
        .where("agent_id", "=", agentId)
        .where("user_account_id", "=", userAccountId)
        .where("status", "=", "pending")
        .executeTakeFirst()

      if (existing) return existing
      throw err
    }
  }

  /**
   * Approve a pending request — creates an agent_user_grant with
   * origin = 'approval'.
   */
  async approve(requestId: string, reviewedBy: string): Promise<AgentUserGrant> {
    const request = await this.db
      .selectFrom("access_request")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirst()

    if (!request) throw new AccessRequestConflictError("Access request not found")
    if (request.status !== "pending") {
      throw new AccessRequestConflictError(`Cannot approve request with status '${request.status}'`)
    }

    await this.db
      .updateTable("access_request")
      .set({
        status: "approved",
        reviewed_by: reviewedBy,
        reviewed_at: new Date(),
      })
      .where("id", "=", requestId)
      .where("status", "=", "pending")
      .execute()

    const grant = await this.db
      .insertInto("agent_user_grant")
      .values({
        agent_id: request.agent_id,
        user_account_id: request.user_account_id,
        origin: "approval",
        granted_by: reviewedBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return grant
  }

  /**
   * Deny a pending request.
   */
  async deny(requestId: string, reviewedBy: string, reason?: string): Promise<void> {
    const request = await this.db
      .selectFrom("access_request")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirst()

    if (!request) throw new AccessRequestConflictError("Access request not found")
    if (request.status !== "pending") {
      throw new AccessRequestConflictError(`Cannot deny request with status '${request.status}'`)
    }

    await this.db
      .updateTable("access_request")
      .set({
        status: "denied",
        reviewed_by: reviewedBy,
        reviewed_at: new Date(),
        deny_reason: reason ?? null,
      })
      .where("id", "=", requestId)
      .where("status", "=", "pending")
      .execute()
  }

  /**
   * List pending requests for a given agent with pagination.
   */
  async listPending(
    agentId: string,
    pagination: { limit?: number; offset?: number } = {},
  ): Promise<{ requests: AccessRequest[]; total: number }> {
    const { limit = 20, offset = 0 } = pagination

    const baseQuery = this.db
      .selectFrom("access_request")
      .where("agent_id", "=", agentId)
      .where("status", "=", "pending")

    const [requests, countResult] = await Promise.all([
      baseQuery.selectAll().orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
      baseQuery.select((eb) => eb.fn.countAll<string>().as("total")).executeTakeFirstOrThrow(),
    ])

    return { requests, total: Number(countResult.total) }
  }

  /**
   * Return per-agent pending-request counts.
   */
  async pendingCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .selectFrom("access_request")
      .select(["agent_id"])
      .select((eb) => eb.fn.countAll<string>().as("cnt"))
      .where("status", "=", "pending")
      .groupBy("agent_id")
      .execute()

    const map = new Map<string, number>()
    for (const row of rows) {
      map.set(row.agent_id, Number(row.cnt))
    }
    return map
  }
}
