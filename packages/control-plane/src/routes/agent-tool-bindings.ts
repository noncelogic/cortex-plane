/**
 * Agent Tool Binding Routes
 *
 * Endpoints for managing tool bindings on agents:
 *   POST   /agents/:agentId/tool-bindings              — create a tool binding
 *   GET    /agents/:agentId/tool-bindings              — list tool bindings
 *   PUT    /agents/:agentId/tool-bindings/:bindingId   — update a tool binding
 *   DELETE /agents/:agentId/tool-bindings/:bindingId   — remove a tool binding
 *   POST   /agents/:agentId/tool-bindings/bulk         — bulk-create from MCP server
 *   GET    /agents/:agentId/effective-tools            — resolved effective tool set
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import type { Database, ToolApprovalPolicy } from "../db/types.js"
import { createRequireAuth, type PreHandler } from "../middleware/auth.js"
import type { AuthConfig, AuthenticatedRequest } from "../middleware/types.js"

export interface AgentToolBindingRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sessionService?: SessionService
}

interface CreateBindingBody {
  toolRef: string
  approvalPolicy?: ToolApprovalPolicy
  approvalCondition?: Record<string, unknown>
  rateLimit?: Record<string, unknown>
  costBudget?: Record<string, unknown>
  dataScope?: Record<string, unknown>
}

interface UpdateBindingBody {
  approvalPolicy?: ToolApprovalPolicy
  approvalCondition?: Record<string, unknown>
  rateLimit?: Record<string, unknown>
  costBudget?: Record<string, unknown>
  dataScope?: Record<string, unknown>
  enabled?: boolean
}

interface BulkCreateBody {
  mcpServerId: string
  toolRefs?: string[]
  approvalPolicy?: ToolApprovalPolicy
}

function toBindingResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    agentId: row.agent_id,
    toolRef: row.tool_ref,
    approvalPolicy: row.approval_policy,
    approvalCondition: row.approval_condition ?? null,
    rateLimit: row.rate_limit ?? null,
    costBudget: row.cost_budget ?? null,
    dataScope: row.data_scope ?? null,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function agentToolBindingRoutes(deps: AgentToolBindingRouteDeps) {
  const { db, authConfig, sessionService } = deps

  const requireAuth: PreHandler = createRequireAuth({
    config: authConfig,
    sessionService,
  })

  return function register(app: FastifyInstance): void {
    /**
     * POST /agents/:agentId/tool-bindings — create a tool binding
     */
    app.post<{
      Params: { agentId: string }
      Body: CreateBindingBody
    }>(
      "/agents/:agentId/tool-bindings",
      {
        preHandler: [requireAuth],
        schema: {
          body: {
            type: "object",
            properties: {
              toolRef: { type: "string", minLength: 1 },
              approvalPolicy: {
                type: "string",
                enum: ["auto", "always_approve", "conditional"],
              },
              approvalCondition: { type: "object" },
              rateLimit: { type: "object" },
              costBudget: { type: "object" },
              dataScope: { type: "object" },
            },
            required: ["toolRef"],
          },
        },
      },
      async (
        request: FastifyRequest<{
          Params: { agentId: string }
          Body: CreateBindingBody
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { agentId } = request.params
        const { toolRef, approvalPolicy, approvalCondition, rateLimit, costBudget, dataScope } =
          request.body

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          reply.status(404).send({ error: "not_found", message: "Agent not found" })
          return
        }

        // Check for duplicate binding
        const existing = await db
          .selectFrom("agent_tool_binding")
          .select("id")
          .where("agent_id", "=", agentId)
          .where("tool_ref", "=", toolRef)
          .executeTakeFirst()

        if (existing) {
          reply.status(409).send({
            error: "conflict",
            message: "Tool is already bound to this agent",
          })
          return
        }

        // Create the binding
        const binding = await db
          .insertInto("agent_tool_binding")
          .values({
            agent_id: agentId,
            tool_ref: toolRef,
            approval_policy: approvalPolicy,
            approval_condition: approvalCondition ?? null,
            rate_limit: rateLimit ?? null,
            cost_budget: costBudget ?? null,
            data_scope: dataScope ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow()

        // Audit log
        await db
          .insertInto("capability_audit_log")
          .values({
            agent_id: agentId,
            tool_ref: toolRef,
            event_type: "binding_created",
            actor_user_id: principal.userId,
            details: { binding_id: binding.id },
          })
          .execute()

        reply.status(201).send({
          binding: toBindingResponse(binding as unknown as Record<string, unknown>),
        })
      },
    )

    /**
     * GET /agents/:agentId/tool-bindings — list tool bindings
     */
    app.get<{
      Params: { agentId: string }
      Querystring: { enabled?: string; category?: string }
    }>(
      "/agents/:agentId/tool-bindings",
      {
        preHandler: [requireAuth],
      },
      async (
        request: FastifyRequest<{
          Params: { agentId: string }
          Querystring: { enabled?: string; category?: string }
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { agentId } = request.params
        const { enabled, category } = request.query

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          reply.status(404).send({ error: "not_found", message: "Agent not found" })
          return
        }

        let query = db.selectFrom("agent_tool_binding").selectAll().where("agent_id", "=", agentId)

        if (enabled !== undefined) {
          query = query.where("enabled", "=", enabled === "true")
        }

        if (category) {
          // Filter by tool_ref prefix pattern for category (e.g. "mcp:slack:" for communication)
          query = query.where("tool_ref", "like", `%${category}%`)
        }

        const rows = await query.orderBy("created_at", "asc").execute()

        return {
          bindings: rows.map((r) => toBindingResponse(r as unknown as Record<string, unknown>)),
          total: rows.length,
        }
      },
    )

    /**
     * PUT /agents/:agentId/tool-bindings/:bindingId — update a tool binding
     */
    app.put<{
      Params: { agentId: string; bindingId: string }
      Body: UpdateBindingBody
    }>(
      "/agents/:agentId/tool-bindings/:bindingId",
      {
        preHandler: [requireAuth],
        schema: {
          body: {
            type: "object",
            properties: {
              approvalPolicy: {
                type: "string",
                enum: ["auto", "always_approve", "conditional"],
              },
              approvalCondition: { type: "object" },
              rateLimit: { type: "object" },
              costBudget: { type: "object" },
              dataScope: { type: "object" },
              enabled: { type: "boolean" },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{
          Params: { agentId: string; bindingId: string }
          Body: UpdateBindingBody
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { agentId, bindingId } = request.params

        // Verify binding exists and belongs to agent
        const existing = await db
          .selectFrom("agent_tool_binding")
          .selectAll()
          .where("id", "=", bindingId)
          .where("agent_id", "=", agentId)
          .executeTakeFirst()

        if (!existing) {
          reply.status(404).send({ error: "not_found", message: "Binding not found" })
          return
        }

        const { approvalPolicy, approvalCondition, rateLimit, costBudget, dataScope, enabled } =
          request.body

        const updates: Record<string, unknown> = { updated_at: new Date() }
        if (approvalPolicy !== undefined) updates.approval_policy = approvalPolicy
        if (approvalCondition !== undefined) updates.approval_condition = approvalCondition
        if (rateLimit !== undefined) updates.rate_limit = rateLimit
        if (costBudget !== undefined) updates.cost_budget = costBudget
        if (dataScope !== undefined) updates.data_scope = dataScope
        if (enabled !== undefined) updates.enabled = enabled

        const updated = await db
          .updateTable("agent_tool_binding")
          .set(updates)
          .where("id", "=", bindingId)
          .where("agent_id", "=", agentId)
          .returningAll()
          .executeTakeFirstOrThrow()

        reply.status(200).send({
          binding: toBindingResponse(updated as unknown as Record<string, unknown>),
        })
      },
    )

    /**
     * DELETE /agents/:agentId/tool-bindings/:bindingId — remove a tool binding
     */
    app.delete<{
      Params: { agentId: string; bindingId: string }
    }>(
      "/agents/:agentId/tool-bindings/:bindingId",
      {
        preHandler: [requireAuth],
      },
      async (
        request: FastifyRequest<{
          Params: { agentId: string; bindingId: string }
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { agentId, bindingId } = request.params

        // Verify binding exists
        const binding = await db
          .selectFrom("agent_tool_binding")
          .select(["id", "tool_ref"])
          .where("id", "=", bindingId)
          .where("agent_id", "=", agentId)
          .executeTakeFirst()

        if (!binding) {
          reply.status(404).send({ error: "not_found", message: "Binding not found" })
          return
        }

        // Delete the binding
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

        reply.status(204).send()
      },
    )

    /**
     * POST /agents/:agentId/tool-bindings/bulk — bulk-create from MCP server
     */
    app.post<{
      Params: { agentId: string }
      Body: BulkCreateBody
    }>(
      "/agents/:agentId/tool-bindings/bulk",
      {
        preHandler: [requireAuth],
        schema: {
          body: {
            type: "object",
            properties: {
              mcpServerId: { type: "string", minLength: 1 },
              toolRefs: { type: "array", items: { type: "string" } },
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
        request: FastifyRequest<{
          Params: { agentId: string }
          Body: BulkCreateBody
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { agentId } = request.params
        const { mcpServerId, toolRefs, approvalPolicy } = request.body

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          reply.status(404).send({ error: "not_found", message: "Agent not found" })
          return
        }

        // Verify MCP server exists
        const server = await db
          .selectFrom("mcp_server")
          .select(["id", "slug"])
          .where("id", "=", mcpServerId)
          .executeTakeFirst()

        if (!server) {
          reply.status(404).send({ error: "not_found", message: "MCP server not found" })
          return
        }

        // Fetch tools from the MCP server
        let toolQuery = db
          .selectFrom("mcp_server_tool")
          .select(["qualified_name"])
          .where("mcp_server_id", "=", mcpServerId)

        if (toolRefs && toolRefs.length > 0) {
          toolQuery = toolQuery.where("qualified_name", "in", toolRefs)
        }

        const tools = await toolQuery.execute()

        if (tools.length === 0) {
          reply.status(200).send({ created: 0, bindings: [] })
          return
        }

        // Get existing bindings to avoid duplicates
        const existingBindings = await db
          .selectFrom("agent_tool_binding")
          .select("tool_ref")
          .where("agent_id", "=", agentId)
          .where(
            "tool_ref",
            "in",
            tools.map((t) => t.qualified_name),
          )
          .execute()

        const existingRefs = new Set(existingBindings.map((b) => b.tool_ref))
        const newToolRefs = tools
          .map((t) => t.qualified_name)
          .filter((ref) => !existingRefs.has(ref))

        if (newToolRefs.length === 0) {
          reply.status(200).send({ created: 0, bindings: [] })
          return
        }

        // Bulk insert
        const values = newToolRefs.map((ref) => ({
          agent_id: agentId,
          tool_ref: ref,
          approval_policy: approvalPolicy ?? ("auto" as const),
        }))

        const bindings = await db
          .insertInto("agent_tool_binding")
          .values(values)
          .returningAll()
          .execute()

        // Audit log
        await db
          .insertInto("capability_audit_log")
          .values(
            bindings.map((b) => ({
              agent_id: agentId,
              tool_ref: b.tool_ref,
              event_type: "binding_created" as const,
              actor_user_id: principal.userId,
              details: { binding_id: b.id, bulk: true, mcp_server_id: mcpServerId },
            })),
          )
          .execute()

        reply.status(201).send({
          created: bindings.length,
          bindings: bindings.map((b) => toBindingResponse(b as unknown as Record<string, unknown>)),
        })
      },
    )

    /**
     * GET /agents/:agentId/effective-tools — resolved effective tool set
     */
    app.get<{
      Params: { agentId: string }
    }>(
      "/agents/:agentId/effective-tools",
      {
        preHandler: [requireAuth],
      },
      async (
        request: FastifyRequest<{
          Params: { agentId: string }
        }>,
        reply: FastifyReply,
      ) => {
        const principal = (request as AuthenticatedRequest).principal
        if (!principal) {
          reply.status(401).send({ error: "unauthorized" })
          return
        }

        const { agentId } = request.params

        // Verify agent exists
        const agent = await db
          .selectFrom("agent")
          .select("id")
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          reply.status(404).send({ error: "not_found", message: "Agent not found" })
          return
        }

        // Get all enabled bindings
        const bindings = await db
          .selectFrom("agent_tool_binding")
          .selectAll()
          .where("agent_id", "=", agentId)
          .where("enabled", "=", true)
          .orderBy("created_at", "asc")
          .execute()

        // Resolve MCP tool metadata for MCP-backed bindings
        const mcpToolRefs = bindings
          .filter((b) => b.tool_ref.startsWith("mcp:"))
          .map((b) => b.tool_ref)

        let mcpToolMap = new Map<
          string,
          { name: string; description: string | null; inputSchema: Record<string, unknown> }
        >()

        if (mcpToolRefs.length > 0) {
          const mcpTools = await db
            .selectFrom("mcp_server_tool")
            .innerJoin("mcp_server", "mcp_server.id", "mcp_server_tool.mcp_server_id")
            .select([
              "mcp_server_tool.qualified_name",
              "mcp_server_tool.name",
              "mcp_server_tool.description",
              "mcp_server_tool.input_schema",
              "mcp_server.status as serverStatus",
            ])
            .where("mcp_server_tool.qualified_name", "in", mcpToolRefs)
            .execute()

          for (const tool of mcpTools) {
            // Exclude tools from non-ACTIVE servers
            if (tool.serverStatus === "ACTIVE") {
              mcpToolMap.set(tool.qualified_name, {
                name: tool.name,
                description: tool.description,
                inputSchema: tool.input_schema,
              })
            }
          }
        }

        const tools = bindings
          .map((b) => {
            const base = {
              toolRef: b.tool_ref,
              bindingId: b.id,
              approvalPolicy: b.approval_policy,
              approvalCondition: b.approval_condition,
              rateLimit: b.rate_limit,
              costBudget: b.cost_budget,
              dataScope: b.data_scope,
            }

            const mcpMeta = mcpToolMap.get(b.tool_ref)
            if (mcpMeta) {
              return {
                ...base,
                name: mcpMeta.name,
                description: mcpMeta.description,
                inputSchema: mcpMeta.inputSchema,
              }
            }

            // Built-in tool — just return the binding info
            return {
              ...base,
              name: b.tool_ref,
              description: null,
              inputSchema: null,
            }
          })
          .filter((t) => {
            // Exclude MCP tools whose server is not active (not in mcpToolMap)
            if (t.toolRef.startsWith("mcp:") && !mcpToolMap.has(t.toolRef)) {
              return false
            }
            return true
          })

        return {
          tools,
          assembledAt: new Date().toISOString(),
        }
      },
    )
  }
}
