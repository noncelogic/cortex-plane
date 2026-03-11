/**
 * Agent Tool Binding Routes
 *
 * Endpoints for managing tool bindings on agents:
 *   POST   /agents/:agentId/tool-bindings              — create a tool binding
 *   GET    /agents/:agentId/tool-bindings              — list bindings (optional filters)
 *   PUT    /agents/:agentId/tool-bindings/:bindingId   — update a binding
 *   DELETE /agents/:agentId/tool-bindings/:bindingId   — remove a binding
 *   POST   /agents/:agentId/tool-bindings/bulk         — bulk-create from MCP server
 *   GET    /agents/:agentId/effective-tools             — computed effective tool set
 *   GET    /agents/:agentId/capability-audit            — query capability audit log
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import type { Database, ToolApprovalPolicy } from "../db/types.js"
import { createRequireAuth, createRequireRole, type PreHandler } from "../middleware/auth.js"
import type { AuthConfig, AuthenticatedRequest } from "../middleware/types.js"

// ============================================================================
// Route types
// ============================================================================

interface AgentParams {
  agentId: string
}

interface BindingParams {
  agentId: string
  bindingId: string
}

interface CreateBindingBody {
  toolRef: string
  approvalPolicy?: ToolApprovalPolicy
  approvalCondition?: Record<string, unknown> | null
  rateLimit?: Record<string, unknown> | null
  costBudget?: Record<string, unknown> | null
  dataScope?: Record<string, unknown> | null
}

interface UpdateBindingBody {
  approvalPolicy?: ToolApprovalPolicy
  approvalCondition?: Record<string, unknown> | null
  rateLimit?: Record<string, unknown> | null
  costBudget?: Record<string, unknown> | null
  dataScope?: Record<string, unknown> | null
  enabled?: boolean
}

interface ListBindingsQuery {
  enabled?: boolean
  category?: string
  limit?: number
  offset?: number
}

interface BulkBindBody {
  mcpServerId: string
  toolRefs?: string[]
  approvalPolicy?: ToolApprovalPolicy
}

interface AuditQuery {
  toolRef?: string
  eventType?: string
  limit?: number
  offset?: number
}

// ============================================================================
// Plugin interface & factory
// ============================================================================

export interface AgentToolBindingRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sessionService?: SessionService
}

export function agentToolBindingRoutes(deps: AgentToolBindingRouteDeps) {
  const { db, authConfig, sessionService } = deps

  const requireAuth: PreHandler = createRequireAuth({
    config: authConfig,
    sessionService,
  })
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // ------------------------------------------------------------------
    // POST /agents/:agentId/tool-bindings — create a tool binding
    // ------------------------------------------------------------------
    app.post<{ Params: AgentParams; Body: CreateBindingBody }>(
      "/agents/:agentId/tool-bindings",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
            },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              toolRef: { type: "string", minLength: 1 },
              approvalPolicy: {
                type: "string",
                enum: ["auto", "always_approve", "conditional"],
              },
              approvalCondition: { type: ["object", "null"] },
              rateLimit: { type: ["object", "null"] },
              costBudget: { type: ["object", "null"] },
              dataScope: { type: ["object", "null"] },
            },
            required: ["toolRef"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Body: CreateBindingBody }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          return reply.status(401).send({ error: "unauthorized" })
        }

        const { agentId } = request.params
        const body = request.body

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Check for duplicate (agentId, toolRef)
        const existing = await db
          .selectFrom("agent_tool_binding")
          .select("id")
          .where("agent_id", "=", agentId)
          .where("tool_ref", "=", body.toolRef)
          .executeTakeFirst()

        if (existing) {
          return reply.status(409).send({
            error: "conflict",
            message: `Tool binding for '${body.toolRef}' already exists on this agent`,
          })
        }

        // Create the binding
        const binding = await db
          .insertInto("agent_tool_binding")
          .values({
            agent_id: agentId,
            tool_ref: body.toolRef,
            approval_policy: body.approvalPolicy ?? "auto",
            approval_condition: body.approvalCondition ?? null,
            rate_limit: body.rateLimit ?? null,
            cost_budget: body.costBudget ?? null,
            data_scope: body.dataScope ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()

        // Audit log
        await db
          .insertInto("capability_audit_log")
          .values({
            agent_id: agentId,
            tool_ref: body.toolRef,
            event_type: "binding_created",
            actor_user_id: principal.userId,
            details: { binding_id: binding.id },
          })
          .execute()

        return reply.status(201).send({
          id: binding.id,
          agentId: binding.agent_id,
          toolRef: binding.tool_ref,
          approvalPolicy: binding.approval_policy,
          approvalCondition: binding.approval_condition,
          rateLimit: binding.rate_limit,
          costBudget: binding.cost_budget,
          dataScope: binding.data_scope,
          enabled: binding.enabled,
          createdAt: binding.created_at,
          updatedAt: binding.updated_at,
        })
      },
    )

    // ------------------------------------------------------------------
    // GET /agents/:agentId/tool-bindings — list bindings
    // ------------------------------------------------------------------
    app.get<{ Params: AgentParams; Querystring: ListBindingsQuery }>(
      "/agents/:agentId/tool-bindings",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
            },
            required: ["agentId"],
          },
          querystring: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              category: { type: "string" },
              limit: { type: "number", minimum: 1, maximum: 100 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Querystring: ListBindingsQuery }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { enabled, category, limit = 50, offset = 0 } = request.query

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        let query = db.selectFrom("agent_tool_binding").selectAll().where("agent_id", "=", agentId)
        let countQuery = db
          .selectFrom("agent_tool_binding")
          .select(db.fn.countAll<number>().as("total"))
          .where("agent_id", "=", agentId)

        if (enabled !== undefined) {
          query = query.where("enabled", "=", enabled)
          countQuery = countQuery.where("enabled", "=", enabled)
        }

        if (category) {
          // Filter by tool_category_membership join
          query = query.where(
            "tool_ref",
            "in",
            db
              .selectFrom("tool_category_membership")
              .select("tool_ref")
              .innerJoin(
                "tool_category",
                "tool_category.id",
                "tool_category_membership.category_id",
              )
              .where("tool_category.name", "=", category),
          )
          countQuery = countQuery.where(
            "tool_ref",
            "in",
            db
              .selectFrom("tool_category_membership")
              .select("tool_ref")
              .innerJoin(
                "tool_category",
                "tool_category.id",
                "tool_category_membership.category_id",
              )
              .where("tool_category.name", "=", category),
          )
        }

        const [bindings, countResult] = await Promise.all([
          query.orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
          countQuery.executeTakeFirstOrThrow(),
        ])

        const total = Number(countResult.total)

        return reply.status(200).send({
          bindings: bindings.map((b) => ({
            id: b.id,
            agentId: b.agent_id,
            toolRef: b.tool_ref,
            approvalPolicy: b.approval_policy,
            approvalCondition: b.approval_condition,
            rateLimit: b.rate_limit,
            costBudget: b.cost_budget,
            dataScope: b.data_scope,
            enabled: b.enabled,
            createdAt: b.created_at,
            updatedAt: b.updated_at,
          })),
          total,
        })
      },
    )

    // ------------------------------------------------------------------
    // PUT /agents/:agentId/tool-bindings/:bindingId — update a binding
    // ------------------------------------------------------------------
    app.put<{ Params: BindingParams; Body: UpdateBindingBody }>(
      "/agents/:agentId/tool-bindings/:bindingId",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
              bindingId: { type: "string", minLength: 1 },
            },
            required: ["agentId", "bindingId"],
          },
          body: {
            type: "object",
            properties: {
              approvalPolicy: {
                type: "string",
                enum: ["auto", "always_approve", "conditional"],
              },
              approvalCondition: { type: ["object", "null"] },
              rateLimit: { type: ["object", "null"] },
              costBudget: { type: ["object", "null"] },
              dataScope: { type: ["object", "null"] },
              enabled: { type: "boolean" },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: BindingParams; Body: UpdateBindingBody }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          return reply.status(401).send({ error: "unauthorized" })
        }

        const { agentId, bindingId } = request.params
        const body = request.body

        // Build the update set — only include provided fields
        const updates: Record<string, unknown> = {}
        if (body.approvalPolicy !== undefined) updates.approval_policy = body.approvalPolicy
        if (body.approvalCondition !== undefined)
          updates.approval_condition = body.approvalCondition
        if (body.rateLimit !== undefined) updates.rate_limit = body.rateLimit
        if (body.costBudget !== undefined) updates.cost_budget = body.costBudget
        if (body.dataScope !== undefined) updates.data_scope = body.dataScope
        if (body.enabled !== undefined) updates.enabled = body.enabled

        if (Object.keys(updates).length === 0) {
          return reply.status(400).send({
            error: "bad_request",
            message: "No fields to update",
          })
        }

        const updated = await db
          .updateTable("agent_tool_binding")
          .set(updates)
          .where("id", "=", bindingId)
          .where("agent_id", "=", agentId)
          .returningAll()
          .executeTakeFirst()

        if (!updated) {
          return reply.status(404).send({ error: "not_found", message: "Binding not found" })
        }

        // Audit log
        await db
          .insertInto("capability_audit_log")
          .values({
            agent_id: agentId,
            tool_ref: updated.tool_ref,
            event_type: "binding_updated",
            actor_user_id: principal.userId,
            details: { binding_id: bindingId, changed_fields: Object.keys(updates) },
          })
          .execute()

        return reply.status(200).send({
          id: updated.id,
          agentId: updated.agent_id,
          toolRef: updated.tool_ref,
          approvalPolicy: updated.approval_policy,
          approvalCondition: updated.approval_condition,
          rateLimit: updated.rate_limit,
          costBudget: updated.cost_budget,
          dataScope: updated.data_scope,
          enabled: updated.enabled,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
        })
      },
    )

    // ------------------------------------------------------------------
    // DELETE /agents/:agentId/tool-bindings/:bindingId — remove a binding
    // ------------------------------------------------------------------
    app.delete<{ Params: BindingParams }>(
      "/agents/:agentId/tool-bindings/:bindingId",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
              bindingId: { type: "string", minLength: 1 },
            },
            required: ["agentId", "bindingId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: BindingParams }>, reply: FastifyReply) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          return reply.status(401).send({ error: "unauthorized" })
        }

        const { agentId, bindingId } = request.params

        // Look up binding to get tool_ref for audit log
        const binding = await db
          .selectFrom("agent_tool_binding")
          .select(["id", "tool_ref"])
          .where("id", "=", bindingId)
          .where("agent_id", "=", agentId)
          .executeTakeFirst()

        if (!binding) {
          return reply.status(404).send({ error: "not_found", message: "Binding not found" })
        }

        await db
          .deleteFrom("agent_tool_binding")
          .where("id", "=", bindingId)
          .where("agent_id", "=", agentId)
          .execute()

        // Audit log
        await db
          .insertInto("capability_audit_log")
          .values({
            agent_id: agentId,
            tool_ref: binding.tool_ref,
            event_type: "binding_removed",
            actor_user_id: principal.userId,
            details: { binding_id: bindingId },
          })
          .execute()

        return reply.status(204).send()
      },
    )

    // ------------------------------------------------------------------
    // POST /agents/:agentId/tool-bindings/bulk — bulk-create from MCP server
    // ------------------------------------------------------------------
    app.post<{ Params: AgentParams; Body: BulkBindBody }>(
      "/agents/:agentId/tool-bindings/bulk",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
            },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              mcpServerId: { type: "string", minLength: 1 },
              toolRefs: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
              approvalPolicy: {
                type: "string",
                enum: ["auto", "always_approve", "conditional"],
              },
            },
            required: ["mcpServerId"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Body: BulkBindBody }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          return reply.status(401).send({ error: "unauthorized" })
        }

        const { agentId } = request.params
        const { mcpServerId, toolRefs, approvalPolicy = "auto" } = request.body

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Verify MCP server exists
        const server = await db
          .selectFrom("mcp_server")
          .select("id")
          .where("id", "=", mcpServerId)
          .executeTakeFirst()

        if (!server) {
          return reply.status(404).send({ error: "not_found", message: "MCP server not found" })
        }

        // Resolve tool refs — either from request body or all tools for the server
        let resolvedRefs: string[]

        if (toolRefs && toolRefs.length > 0) {
          resolvedRefs = toolRefs
        } else {
          const serverTools = await db
            .selectFrom("mcp_server_tool")
            .select("qualified_name")
            .where("mcp_server_id", "=", mcpServerId)
            .execute()

          resolvedRefs = serverTools.map((t) => t.qualified_name)
        }

        if (resolvedRefs.length === 0) {
          return reply.status(200).send({ created: 0, bindings: [] })
        }

        // Insert bindings, skipping duplicates
        const values = resolvedRefs.map((ref) => ({
          agent_id: agentId,
          tool_ref: ref,
          approval_policy: approvalPolicy as "auto" | "always_approve" | "conditional",
        }))

        const created = await db
          .insertInto("agent_tool_binding")
          .values(values)
          .onConflict((oc) => oc.columns(["agent_id", "tool_ref"]).doNothing())
          .returningAll()
          .execute()

        // Audit log for each created binding
        if (created.length > 0) {
          await db
            .insertInto("capability_audit_log")
            .values(
              created.map((b) => ({
                agent_id: agentId,
                tool_ref: b.tool_ref,
                event_type: "binding_created",
                actor_user_id: principal.userId,
                details: { binding_id: b.id, bulk: true, mcp_server_id: mcpServerId },
              })),
            )
            .execute()
        }

        return reply.status(201).send({
          created: created.length,
          bindings: created.map((b) => ({
            id: b.id,
            agentId: b.agent_id,
            toolRef: b.tool_ref,
            approvalPolicy: b.approval_policy,
            enabled: b.enabled,
            createdAt: b.created_at,
          })),
        })
      },
    )

    // ------------------------------------------------------------------
    // GET /agents/:agentId/effective-tools — computed effective tool set
    // ------------------------------------------------------------------
    app.get<{ Params: AgentParams }>(
      "/agents/:agentId/effective-tools",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
            },
            required: ["agentId"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
        const { agentId } = request.params

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        // Return enabled bindings as effective tools.
        // When CapabilityAssembler (#302) is integrated, this will call
        // assembler.resolveEffectiveTools(agentId) instead.
        const bindings = await db
          .selectFrom("agent_tool_binding")
          .selectAll()
          .where("agent_id", "=", agentId)
          .where("enabled", "=", true)
          .orderBy("created_at", "asc")
          .execute()

        return reply.status(200).send({
          tools: bindings.map((b) => ({
            toolRef: b.tool_ref,
            bindingId: b.id,
            approvalPolicy: b.approval_policy,
            approvalCondition: b.approval_condition,
            rateLimit: b.rate_limit,
            costBudget: b.cost_budget,
            dataScope: b.data_scope,
          })),
          assembledAt: new Date().toISOString(),
        })
      },
    )

    // ------------------------------------------------------------------
    // GET /agents/:agentId/capability-audit — query capability audit log
    // ------------------------------------------------------------------
    app.get<{ Params: AgentParams; Querystring: AuditQuery }>(
      "/agents/:agentId/capability-audit",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string", minLength: 1 },
            },
            required: ["agentId"],
          },
          querystring: {
            type: "object",
            properties: {
              toolRef: { type: "string" },
              eventType: { type: "string" },
              limit: { type: "number", minimum: 1, maximum: 100 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: AgentParams; Querystring: AuditQuery }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { toolRef, eventType, limit = 50, offset = 0 } = request.query

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        let query = db
          .selectFrom("capability_audit_log")
          .selectAll()
          .where("agent_id", "=", agentId)
        let countQuery = db
          .selectFrom("capability_audit_log")
          .select(db.fn.countAll<number>().as("total"))
          .where("agent_id", "=", agentId)

        if (toolRef) {
          query = query.where("tool_ref", "=", toolRef)
          countQuery = countQuery.where("tool_ref", "=", toolRef)
        }

        if (eventType) {
          query = query.where("event_type", "=", eventType)
          countQuery = countQuery.where("event_type", "=", eventType)
        }

        const [entries, countResult] = await Promise.all([
          query.orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
          countQuery.executeTakeFirstOrThrow(),
        ])

        const total = Number(countResult.total)

        return reply.status(200).send({
          entries: entries.map((e) => ({
            id: e.id,
            agentId: e.agent_id,
            toolRef: e.tool_ref,
            eventType: e.event_type,
            actorUserId: e.actor_user_id,
            jobId: e.job_id,
            details: e.details,
            createdAt: e.created_at,
          })),
          total,
        })
      },
    )
  }
}
