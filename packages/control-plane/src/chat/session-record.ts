import type { Kysely } from "kysely"

import type { Database, Session } from "../db/types.js"
import type { SessionResolutionDiagnostics } from "./runtime-contract.js"

export type SessionLifecycleStatus = "active" | "idle" | "archived" | "closed"

export class SessionResolutionError extends Error {
  constructor(
    readonly code: "not_found" | "closed",
    message: string,
  ) {
    super(message)
    this.name = "SessionResolutionError"
  }
}

interface SessionLifecycleEvent {
  source: SessionResolutionDiagnostics
  at: string
}

function asLifecycleObject(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const lifecycle =
    metadata?.lifecycle && typeof metadata.lifecycle === "object" && metadata.lifecycle !== null
      ? { ...(metadata.lifecycle as Record<string, unknown>) }
      : {}
  return lifecycle
}

function buildLifecycleMetadata(params: {
  existingMetadata: Record<string, unknown> | null | undefined
  event: "create" | "resume" | "activity" | "idle" | "close"
  source: SessionResolutionDiagnostics
  at: Date
}): Record<string, unknown> {
  const base = { ...(params.existingMetadata ?? {}) }
  const lifecycle = asLifecycleObject(base)
  const eventPayload: SessionLifecycleEvent = {
    source: params.source,
    at: params.at.toISOString(),
  }
  const resumeCount = typeof lifecycle.resume_count === "number" ? lifecycle.resume_count : 0

  if (params.event === "create") {
    lifecycle.created = eventPayload
    lifecycle.resume_count = 0
  }
  if (params.event === "resume") {
    lifecycle.last_resumed = eventPayload
    lifecycle.resume_count = resumeCount + 1
  }
  if (params.event === "activity") {
    lifecycle.last_activity = eventPayload
  }
  if (params.event === "idle") {
    lifecycle.last_idle = eventPayload
  }
  if (params.event === "close") {
    lifecycle.closed = eventPayload
  }

  lifecycle.last_source = params.source
  base.lifecycle = lifecycle
  return base
}

function isReusableStatus(status: string): boolean {
  if (!status) return true
  return status === "active" || status === "idle" || status === "archived"
}

function applySessionPatch(session: Session, patch: Partial<Session>): Session {
  return {
    ...session,
    ...patch,
  }
}

async function activateSession(
  db: Kysely<Database>,
  session: Session,
  source: SessionResolutionDiagnostics,
): Promise<Session> {
  if (session.status === "closed") {
    throw new SessionResolutionError("closed", "Session is closed and cannot be resumed")
  }

  const now = new Date()
  const resumed = session.status !== "active" || session.channel_id !== source.channelId
  const metadata = buildLifecycleMetadata({
    existingMetadata: session.metadata,
    event: resumed ? "resume" : "activity",
    source,
    at: now,
  })

  await db
    .updateTable("session")
    .set({
      status: "active",
      channel_id: source.channelId,
      metadata,
      last_activity_at: now,
      last_resumed_at: resumed ? now : (session.last_resumed_at ?? now),
      idle_at: resumed ? null : session.idle_at,
      archived_at: resumed ? null : session.archived_at,
    })
    .where("id", "=", session.id)
    .execute()

  return applySessionPatch(session, {
    status: "active",
    channel_id: source.channelId,
    metadata,
    last_activity_at: now,
    last_resumed_at: resumed ? now : (session.last_resumed_at ?? now),
    idle_at: resumed ? null : session.idle_at,
    archived_at: resumed ? null : session.archived_at,
  })
}

async function idleSiblingSessions(
  db: Kysely<Database>,
  params: {
    agentId: string
    userAccountId: string
    keepSessionId: string
    source: SessionResolutionDiagnostics
  },
): Promise<void> {
  const activeSiblings = db
    .selectFrom("session")
    .selectAll()
    .where("agent_id", "=", params.agentId)
    .where("user_account_id", "=", params.userAccountId)
    .where("status", "=", "active")

  const siblingRows =
    typeof activeSiblings.execute === "function"
      ? await activeSiblings.execute()
      : [await activeSiblings.executeTakeFirst()].filter((row): row is Session => Boolean(row))

  const now = new Date()
  for (const sibling of siblingRows) {
    if (sibling.id === params.keepSessionId) continue
    await db
      .updateTable("session")
      .set({
        status: "idle",
        metadata: buildLifecycleMetadata({
          existingMetadata: sibling.metadata,
          event: "idle",
          source: params.source,
          at: now,
        }),
        last_activity_at: now,
        idle_at: now,
      })
      .where("id", "=", sibling.id)
      .execute()
  }
}

export async function ensureUserAccount(
  db: Kysely<Database>,
  userAccountId: string,
  displayName?: string,
): Promise<void> {
  const existing = await db
    .selectFrom("user_account")
    .select("id")
    .where("id", "=", userAccountId)
    .executeTakeFirst()

  if (existing) return

  await db
    .insertInto("user_account")
    .values({
      id: userAccountId,
      display_name: displayName ?? null,
      role: "operator",
    })
    .execute()
}

export async function resolveSessionRecord(
  db: Kysely<Database>,
  params: {
    agentId: string
    userAccountId: string
    source: SessionResolutionDiagnostics
    requestedSessionId?: string
  },
): Promise<Session> {
  const { agentId, userAccountId, source, requestedSessionId } = params

  if (requestedSessionId) {
    const requested = await db
      .selectFrom("session")
      .selectAll()
      .where("id", "=", requestedSessionId)
      .where("agent_id", "=", agentId)
      .where("user_account_id", "=", userAccountId)
      .executeTakeFirst()

    if (!requested) {
      throw new SessionResolutionError("not_found", "Session not found")
    }

    const active = await activateSession(db, requested, source)
    await idleSiblingSessions(db, {
      agentId,
      userAccountId,
      keepSessionId: active.id,
      source,
    })
    return active
  }

  const sameChannel = await db
    .selectFrom("session")
    .selectAll()
    .where("agent_id", "=", agentId)
    .where("user_account_id", "=", userAccountId)
    .where("channel_id", "=", source.channelId)
    .executeTakeFirst()

  if (sameChannel && isReusableStatus(sameChannel.status)) {
    const active = await activateSession(db, sameChannel, source)
    await idleSiblingSessions(db, {
      agentId,
      userAccountId,
      keepSessionId: active.id,
      source,
    })
    return active
  }

  const anyReusable = await db
    .selectFrom("session")
    .selectAll()
    .where("agent_id", "=", agentId)
    .where("user_account_id", "=", userAccountId)
    .executeTakeFirst()

  if (anyReusable && isReusableStatus(anyReusable.status)) {
    const active = await activateSession(db, anyReusable, source)
    await idleSiblingSessions(db, {
      agentId,
      userAccountId,
      keepSessionId: active.id,
      source,
    })
    return active
  }

  const now = new Date()
  const metadata = buildLifecycleMetadata({
    existingMetadata: null,
    event: "create",
    source,
    at: now,
  })
  const created = await db
    .insertInto("session")
    .values({
      agent_id: agentId,
      user_account_id: userAccountId,
      channel_id: source.channelId,
      status: "active",
      metadata,
      last_activity_at: now,
      last_resumed_at: now,
    })
    .returning([
      "id",
      "agent_id",
      "user_account_id",
      "channel_id",
      "status",
      "metadata",
      "total_tokens_in",
      "total_tokens_out",
      "total_cost_usd",
      "last_activity_at",
      "last_resumed_at",
      "idle_at",
      "archived_at",
      "closed_at",
      "created_at",
      "updated_at",
    ])
    .executeTakeFirstOrThrow()

  await idleSiblingSessions(db, {
    agentId,
    userAccountId,
    keepSessionId: created.id,
    source,
  })

  return created
}

export async function getSessionRecord(
  db: Kysely<Database>,
  sessionId: string,
): Promise<Session | undefined> {
  return db.selectFrom("session").selectAll().where("id", "=", sessionId).executeTakeFirst()
}

export async function closeSessionRecord(
  db: Kysely<Database>,
  params: {
    sessionId: string
    source: SessionResolutionDiagnostics
  },
): Promise<Session | undefined> {
  const existing = await getSessionRecord(db, params.sessionId)
  if (!existing) return undefined

  const now = new Date()
  const metadata = buildLifecycleMetadata({
    existingMetadata: existing.metadata,
    event: "close",
    source: params.source,
    at: now,
  })

  await db
    .updateTable("session")
    .set({
      status: "closed",
      metadata,
      last_activity_at: now,
      closed_at: now,
    })
    .where("id", "=", params.sessionId)
    .execute()

  return applySessionPatch(existing, {
    status: "closed",
    metadata,
    last_activity_at: now,
    closed_at: now,
  })
}

export async function resumeSessionRecord(
  db: Kysely<Database>,
  params: {
    sessionId: string
    source: SessionResolutionDiagnostics
  },
): Promise<Session> {
  const existing = await getSessionRecord(db, params.sessionId)
  if (!existing) {
    throw new SessionResolutionError("not_found", "Session not found")
  }

  const active = await activateSession(db, existing, params.source)
  await idleSiblingSessions(db, {
    agentId: active.agent_id,
    userAccountId: active.user_account_id,
    keepSessionId: active.id,
    source: params.source,
  })
  return active
}
