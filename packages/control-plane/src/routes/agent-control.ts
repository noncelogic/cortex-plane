/**
 * Agent Control Routes
 *
 * POST /agents/:agentId/dry-run — simulate an agent turn without tool execution
 * POST /agents/:agentId/kill    — immediate execution cancellation (kill switch)
 */

import Anthropic from "@anthropic-ai/sdk"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import type { SessionService } from "../auth/session-service.js"
import { createAgentToolRegistry } from "../backends/tool-executor.js"
import type { Database } from "../db/types.js"
import type { McpToolRouter } from "../mcp/tool-router.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  createRequireRole,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig } from "../middleware/types.js"
import {
  type DryRunResult,
  estimateCost,
  loadConversationContext,
  type PlannedAction,
} from "../observability/dry-run.js"
import type { AgentEventEmitter } from "../observability/event-emitter.js"
import type { ExecutionRegistry } from "../observability/execution-registry.js"
import type { SSEConnectionManager } from "../streaming/manager.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface DryRunParams {
  agentId: string
}

interface DryRunBody {
  message: string
  sessionId?: string
  maxTurns?: number
}

interface KillParams {
  agentId: string
}

interface KillBody {
  reason: string
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface AgentControlRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sessionService?: SessionService
  mcpToolRouter?: McpToolRouter
  executionRegistry?: ExecutionRegistry
  eventEmitter?: AgentEventEmitter
  sseManager?: SSEConnectionManager
}

export function agentControlRoutes(deps: AgentControlRouteDeps) {
  const {
    db,
    authConfig,
    sessionService,
    mcpToolRouter,
    executionRegistry,
    eventEmitter,
    sseManager,
  } = deps

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // POST /agents/:agentId/dry-run — simulate agent turn
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: DryRunParams; Body: DryRunBody }>(
      "/agents/:agentId/dry-run",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              agentId: { type: "string" },
            },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              message: { type: "string", minLength: 1, maxLength: 50_000 },
              sessionId: { type: "string" },
              maxTurns: { type: "number", minimum: 1, maximum: 1 },
            },
            required: ["message"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: DryRunParams; Body: DryRunBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { message, sessionId } = request.body

        // Load agent
        const agent = await db
          .selectFrom("agent")
          .selectAll()
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        if (agent.status !== "ACTIVE") {
          return reply.status(409).send({
            error: "conflict",
            message: `Agent is ${agent.status}, must be ACTIVE for dry run`,
          })
        }

        // Resolve tool definitions (same as normal execution)
        const agentConfig = agent.config ?? {}
        const skillConfig = agent.skill_config ?? {}
        const allowedTools: string[] = Array.isArray(skillConfig.allowedTools)
          ? (skillConfig.allowedTools as string[])
          : []
        const deniedTools: string[] = Array.isArray(skillConfig.deniedTools)
          ? (skillConfig.deniedTools as string[])
          : []

        const registry = await createAgentToolRegistry(agentConfig, {
          agentId: agent.id,
          mcpRouter: mcpToolRouter,
          allowedTools,
          deniedTools,
        })

        // Get tool definitions (for the LLM to see)
        const toolDefs = registry.resolve(allowedTools, deniedTools)
        const anthropicTools: Anthropic.Tool[] = toolDefs.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        }))

        // Load conversation context
        const conversationHistory = await loadConversationContext(db, sessionId)

        // Build system prompt (mirrors agent-execute.ts)
        const modelConfig = agent.model_config ?? {}
        const systemPrompt =
          typeof modelConfig.systemPrompt === "string"
            ? modelConfig.systemPrompt
            : `You are ${agent.name}, a ${agent.role} agent.${agent.description ? ` ${agent.description}` : ""}`

        // Resolve API key
        const apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? ""
        if (!apiKey) {
          return reply.status(503).send({
            error: "service_unavailable",
            message: "No LLM API key configured for dry run",
          })
        }

        // Build messages
        const messages: Anthropic.MessageParam[] = []
        for (const turn of conversationHistory) {
          messages.push({ role: turn.role, content: turn.content })
        }
        messages.push({ role: "user", content: message })

        // Resolve model
        const model =
          typeof modelConfig.model === "string" ? modelConfig.model : "claude-sonnet-4-5-20250929"

        // Execute one LLM turn
        const client = new Anthropic({ apiKey })
        const plannedActions: PlannedAction[] = []
        let agentResponse = ""

        try {
          const response = await client.messages.create({
            model,
            max_tokens: 4096,
            system: systemPrompt,
            messages,
            ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
          })

          // Extract text + tool_use blocks
          for (const block of response.content) {
            if (block.type === "text") {
              agentResponse += block.text
            } else if (block.type === "tool_use") {
              plannedActions.push({
                type: "tool_call",
                toolRef: block.name,
                input: block.input as Record<string, unknown>,
              })
            }
          }

          const costUsd = estimateCost({
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            costUsd: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          })

          const result: DryRunResult = {
            plannedActions,
            agentResponse,
            tokensUsed: { in: response.usage.input_tokens, out: response.usage.output_tokens },
            estimatedCostUsd: costUsd,
          }

          return reply.status(200).send(result)
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "LLM API error"
          return reply.status(502).send({
            error: "llm_error",
            message: `Dry run LLM call failed: ${errorMsg}`,
          })
        }
      },
    )

    // -----------------------------------------------------------------
    // POST /agents/:agentId/kill — immediate execution cancellation
    // Requires: auth + operator role
    // -----------------------------------------------------------------
    app.post<{ Params: KillParams; Body: KillBody }>(
      "/agents/:agentId/kill",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: { agentId: { type: "string" } },
            required: ["agentId"],
          },
          body: {
            type: "object",
            properties: {
              reason: { type: "string", minLength: 1, maxLength: 1000 },
            },
            required: ["reason"],
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: KillParams; Body: KillBody }>,
        reply: FastifyReply,
      ) => {
        const { agentId } = request.params
        const { reason } = request.body

        // Check agent exists in DB
        const agent = await db
          .selectFrom("agent")
          .select(["id", "status"])
          .where("id", "=", agentId)
          .executeTakeFirst()

        if (!agent) {
          return reply.status(404).send({ error: "not_found", message: "Agent not found" })
        }

        if (agent.status === "QUARANTINED") {
          return reply.status(409).send({
            error: "conflict",
            message: "Agent is already quarantined",
          })
        }

        const previousState = agent.status

        // Look up the agent's current running job
        const runningJob = await db
          .selectFrom("job")
          .select(["id"])
          .where("agent_id", "=", agentId)
          .where("status", "=", "RUNNING")
          .executeTakeFirst()

        let cancelledJobId: string | null = null

        if (runningJob) {
          cancelledJobId = runningJob.id

          // Cancel in-flight execution via AbortController
          if (executionRegistry) {
            await executionRegistry.cancel(runningJob.id, reason)
          }

          // Transition job to FAILED with operator_kill category
          await db
            .updateTable("job")
            .set({
              status: "FAILED",
              error: { category: "operator_kill", message: reason },
              completed_at: new Date(),
            })
            .where("id", "=", runningJob.id)
            .where("status", "=", "RUNNING")
            .execute()
        }

        // Transition agent to QUARANTINED
        await db
          .updateTable("agent")
          .set({ status: "QUARANTINED" })
          .where("id", "=", agentId)
          .execute()

        const killedAt = new Date().toISOString()

        // Emit kill_requested event to agent_event
        if (eventEmitter) {
          await eventEmitter.emit({
            agentId,
            jobId: cancelledJobId,
            eventType: "kill_requested",
            payload: { reason, cancelledJobId },
          })
        }

        // Broadcast agent:killed SSE event to connected clients
        if (sseManager) {
          sseManager.broadcast(agentId, "agent:killed", {
            agentId,
            previousState,
            cancelledJobId,
            state: "QUARANTINED",
            reason,
            killedAt,
          })
        }

        return reply.status(200).send({
          agentId,
          previousState,
          cancelledJobId,
          state: "QUARANTINED",
          killedAt,
        })
      },
    )
  }
}
