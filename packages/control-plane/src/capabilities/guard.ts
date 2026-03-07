/**
 * CapabilityGuard
 *
 * Wraps a tool's execute() function with rate limiting, approval policy
 * enforcement, data scope injection, and audit logging.
 */

import type { Kysely } from "kysely"

import type { ApprovalService } from "../approval/service.js"
import type { ToolDefinition } from "../backends/tool-executor.js"
import type { Database } from "../db/types.js"
import { ToolApprovalRequiredError, ToolRateLimitError } from "./errors.js"
import type { EffectiveTool } from "./types.js"

// ---------------------------------------------------------------------------
// Conditional approval evaluation
// ---------------------------------------------------------------------------

interface ApprovalCondition {
  field: string
  operator: string
  value: unknown
}

/** Convert a simple glob pattern (only `*` wildcard) into a RegExp. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/([.+?^${}()|[\]\\])/g, "\\$1").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

/**
 * Evaluate an approval condition against tool input.
 *
 * Supported operators: equals, not_equals, matches, not_matches, in, not_in.
 */
export function evaluateCondition(
  condition: ApprovalCondition,
  input: Record<string, unknown>,
): boolean {
  const fieldValue = input[condition.field]

  switch (condition.operator) {
    case "equals":
      return fieldValue === condition.value
    case "not_equals":
      return fieldValue !== condition.value
    case "matches":
      return typeof fieldValue === "string" && globToRegex(String(condition.value)).test(fieldValue)
    case "not_matches":
      return (
        typeof fieldValue === "string" && !globToRegex(String(condition.value)).test(fieldValue)
      )
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(fieldValue)
    case "not_in":
      return Array.isArray(condition.value) && !condition.value.includes(fieldValue)
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// CapabilityGuard
// ---------------------------------------------------------------------------

export class CapabilityGuard {
  /**
   * Wrap an EffectiveTool's execute function with guard checks.
   * Returns a new ToolDefinition whose execute() enforces:
   *   1. Rate limiting (sliding window via capability_audit_log)
   *   2. Approval policy
   *   3. Data scope injection (_cortex_scope)
   *   4. Audit logging
   */
  static wrap(
    tool: EffectiveTool,
    context: { agentId: string; jobId: string; userId: string },
    deps: { db: Kysely<Database>; approvalService?: ApprovalService },
  ): ToolDefinition {
    return {
      name: tool.toolDefinition.name,
      description: tool.toolDefinition.description,
      inputSchema: tool.toolDefinition.inputSchema,
      execute: async (input: Record<string, unknown>): Promise<string> => {
        // 1. Rate limit check
        if (tool.rateLimit) {
          const count = await CapabilityGuard.countRecentInvocations(
            deps.db,
            context.agentId,
            tool.toolRef,
            tool.rateLimit.windowSeconds,
          )
          if (count >= tool.rateLimit.maxCalls) {
            await CapabilityGuard.logAudit(deps.db, {
              agentId: context.agentId,
              toolRef: tool.toolRef,
              eventType: "rate_limited",
              jobId: context.jobId,
              actorUserId: context.userId,
              details: { input, limit: tool.rateLimit },
            })
            throw new ToolRateLimitError(tool.toolRef, tool.rateLimit)
          }
        }

        // 2. Approval policy check
        const needsApproval = CapabilityGuard.requiresApproval(tool, input)
        if (needsApproval) {
          const approvalRequestId = await CapabilityGuard.createApprovalRequest(
            tool,
            context,
            deps,
            input,
          )
          await CapabilityGuard.logAudit(deps.db, {
            agentId: context.agentId,
            toolRef: tool.toolRef,
            eventType: "approval_required",
            jobId: context.jobId,
            actorUserId: context.userId,
            details: { input, approvalRequestId },
          })
          throw new ToolApprovalRequiredError(tool.toolRef, approvalRequestId)
        }

        // 3. Data scope injection
        const scopedInput = tool.dataScope ? { ...input, _cortex_scope: tool.dataScope } : input

        // 4. Execute the underlying tool
        const result = await tool.toolDefinition.execute(scopedInput)

        // 5. Audit log
        await CapabilityGuard.logAudit(deps.db, {
          agentId: context.agentId,
          toolRef: tool.toolRef,
          eventType: "tool_invoked",
          jobId: context.jobId,
          actorUserId: context.userId,
          details: {},
        })

        return result
      },
    }
  }

  /**
   * Determine whether the tool invocation requires approval.
   */
  private static requiresApproval(tool: EffectiveTool, input: Record<string, unknown>): boolean {
    if (tool.approvalPolicy === "always_approve") return true
    if (tool.approvalPolicy === "conditional" && tool.approvalCondition) {
      return evaluateCondition(tool.approvalCondition as unknown as ApprovalCondition, input)
    }
    return false
  }

  /**
   * Create an approval request via ApprovalService, or return a placeholder
   * ID if no ApprovalService is available.
   */
  private static async createApprovalRequest(
    tool: EffectiveTool,
    context: { agentId: string; jobId: string; userId: string },
    deps: { db: Kysely<Database>; approvalService?: ApprovalService },
    input: Record<string, unknown>,
  ): Promise<string> {
    if (!deps.approvalService) return "pending"

    const result = await deps.approvalService.createRequest({
      jobId: context.jobId,
      agentId: context.agentId,
      actionType: "tool_invocation",
      actionSummary: `Invoke ${tool.toolRef}`,
      actionDetail: { toolRef: tool.toolRef, input, bindingId: tool.bindingId },
      approverUserAccountId: context.userId,
      riskLevel: "P2",
    })
    return result.approvalRequestId
  }

  private static async countRecentInvocations(
    db: Kysely<Database>,
    agentId: string,
    toolRef: string,
    windowSeconds: number,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - windowSeconds * 1000)
    const result = await db
      .selectFrom("capability_audit_log")
      .select(db.fn.countAll<number>().as("count"))
      .where("agent_id", "=", agentId)
      .where("tool_ref", "=", toolRef)
      .where("event_type", "=", "tool_invoked")
      .where("created_at", ">", cutoff)
      .executeTakeFirst()
    return Number(result?.count ?? 0)
  }

  private static async logAudit(
    db: Kysely<Database>,
    entry: {
      agentId: string
      toolRef: string
      eventType: string
      jobId?: string
      actorUserId?: string
      details: Record<string, unknown>
    },
  ): Promise<void> {
    await db
      .insertInto("capability_audit_log")
      .values({
        agent_id: entry.agentId,
        tool_ref: entry.toolRef,
        event_type: entry.eventType,
        job_id: entry.jobId ?? null,
        actor_user_id: entry.actorUserId ?? null,
        details: entry.details,
      })
      .execute()
      .catch(() => {
        // Non-fatal: audit logging must not fail execution.
      })
  }
}
