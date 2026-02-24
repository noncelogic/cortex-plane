/**
 * Agent context hydration.
 *
 * Sequential hydration: PostgreSQL checkpoint (mandatory) → Qdrant context (optional).
 * Parallel where safe — checkpoint + identity load run concurrently since they
 * are independent PostgreSQL queries. Qdrant follows because it depends on
 * the job payload / checkpoint context for its query.
 *
 * Hydration order rationale (spike #34, Q5):
 * - Checkpoint tells the agent where it is in execution.
 * - Qdrant query needs job context from checkpoint to be meaningful.
 * - Identity loading is independent and parallelizes with checkpoint.
 */

import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckpointData {
  checkpoint: Record<string, unknown> | null
  checkpointCrc: number | null
  jobStatus: string
  attempt: number
  payload: Record<string, unknown>
}

export interface AgentIdentity {
  agentId: string
  name: string
  slug: string
  role: string
  description: string | null
  modelConfig: Record<string, unknown>
  skillConfig: Record<string, unknown>
  resourceLimits: Record<string, unknown>
}

export interface QdrantContext {
  memories: Array<{
    id: string
    content: string
    score: number
    type: string
  }>
}

export interface HydrationResult {
  checkpoint: CheckpointData
  identity: AgentIdentity
  qdrantContext: QdrantContext | null
}

export interface QdrantClient {
  search(
    collectionName: string,
    query: string,
    limit: number,
  ): Promise<
    Array<{
      id: string
      payload: Record<string, unknown>
      score: number
    }>
  >
}

// ---------------------------------------------------------------------------
// Checkpoint loading
// ---------------------------------------------------------------------------

/**
 * Load the last checkpoint for a job from PostgreSQL.
 * This is mandatory — if the checkpoint can't be loaded, hydration fails.
 */
export async function loadCheckpoint(jobId: string, db: Kysely<Database>): Promise<CheckpointData> {
  const job = await db
    .selectFrom("job")
    .select(["checkpoint", "checkpoint_crc", "status", "attempt", "payload"])
    .where("id", "=", jobId)
    .executeTakeFirst()

  if (!job) {
    throw new Error(`Job not found: ${jobId}`)
  }

  return {
    checkpoint: job.checkpoint as Record<string, unknown> | null,
    checkpointCrc: job.checkpoint_crc,
    jobStatus: job.status,
    attempt: job.attempt,
    payload: job.payload as Record<string, unknown>,
  }
}

// ---------------------------------------------------------------------------
// Identity loading
// ---------------------------------------------------------------------------

/**
 * Load agent identity, skills, and persona from the database.
 */
export async function loadIdentity(agentId: string, db: Kysely<Database>): Promise<AgentIdentity> {
  const agent = await db
    .selectFrom("agent")
    .select([
      "id",
      "name",
      "slug",
      "role",
      "description",
      "model_config",
      "skill_config",
      "resource_limits",
    ])
    .where("id", "=", agentId)
    .executeTakeFirst()

  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`)
  }

  return {
    agentId: agent.id,
    name: agent.name,
    slug: agent.slug,
    role: agent.role,
    description: agent.description,
    modelConfig: agent.model_config as Record<string, unknown>,
    skillConfig: agent.skill_config as Record<string, unknown>,
    resourceLimits: agent.resource_limits as Record<string, unknown>,
  }
}

// ---------------------------------------------------------------------------
// Qdrant context loading
// ---------------------------------------------------------------------------

/** Timeout for Qdrant context fetch (10 seconds). */
export const QDRANT_TIMEOUT_MS = 10_000

/**
 * Fetch relevant memories from Qdrant for the current job context.
 * This is optional — if Qdrant is unavailable, the agent proceeds without.
 *
 * @param agentSlug - Agent slug used for collection naming (e.g., memories_devops_01)
 * @param query - Semantic query derived from job payload / checkpoint context
 * @param client - Qdrant client instance
 * @param limit - Maximum number of memories to retrieve (default: 10)
 */
export async function loadQdrantContext(
  agentSlug: string,
  query: string,
  client: QdrantClient,
  limit: number = 10,
): Promise<QdrantContext> {
  const collectionName = `memories_${agentSlug.replace(/-/g, "_")}`

  const results = await Promise.race([
    client.search(collectionName, query, limit),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Qdrant timeout")), QDRANT_TIMEOUT_MS),
    ),
  ])

  return {
    memories: results.map((r) => ({
      id: String(r.id),
      content: String(r.payload.content ?? ""),
      score: r.score,
      type: String(r.payload.type ?? "unknown"),
    })),
  }
}

// ---------------------------------------------------------------------------
// Full hydration pipeline
// ---------------------------------------------------------------------------

/**
 * Run the complete hydration pipeline:
 * 1. (Parallel) Load checkpoint + Load identity
 * 2. (Sequential) Load Qdrant context (depends on job context from step 1)
 *
 * Qdrant failure is non-fatal — the agent proceeds without memory context.
 */
export async function hydrateAgent(options: {
  jobId: string
  agentId: string
  db: Kysely<Database>
  qdrantClient?: QdrantClient
}): Promise<HydrationResult> {
  const { jobId, agentId, db, qdrantClient } = options

  // Step 1: Parallel — checkpoint + identity are independent PG queries.
  const [checkpoint, identity] = await Promise.all([
    loadCheckpoint(jobId, db),
    loadIdentity(agentId, db),
  ])

  // Step 2: Qdrant context — depends on payload from checkpoint.
  let qdrantContext: QdrantContext | null = null

  if (qdrantClient) {
    const queryText = buildQdrantQuery(checkpoint.payload, identity)

    try {
      qdrantContext = await loadQdrantContext(identity.slug, queryText, qdrantClient)
    } catch {
      // Qdrant is optional — log and proceed without memory context.
    }
  }

  return { checkpoint, identity, qdrantContext }
}

/**
 * Build a meaningful Qdrant query from the job payload and agent identity.
 */
function buildQdrantQuery(payload: Record<string, unknown>, identity: AgentIdentity): string {
  const parts: string[] = []

  if (typeof payload.description === "string") {
    parts.push(payload.description)
  }
  if (typeof payload.task === "string") {
    parts.push(payload.task)
  }

  if (parts.length === 0) {
    parts.push(`Context for ${identity.role} agent ${identity.name}`)
  }

  return parts.join(". ")
}
