/**
 * Subagent Capability Delegation
 *
 * Validates delegation requests from parent agents to subagents.
 * Implements the inheritance model:
 *   Subagent.effectiveTools = Parent.effectiveTools ∩ DelegationGrant
 *
 * Rules:
 *   1. Default: empty set (subagent with no explicit delegation has zero tools).
 *   2. Delegation must be a subset of parent's effective tools.
 *   3. Approval policies transfer (cannot downgrade always_approve to auto).
 *   4. Rate limits are shared between parent and subagent.
 */

import type { Kysely } from "kysely"

import type { Database } from "../db/types.js"
import type { CapabilityAssembler } from "./assembler.js"
import type { EffectiveTool } from "./types.js"

export interface DelegationRequest {
  /** Subagent ID. */
  agentId: string
  /** Tool refs the parent wants to delegate to the subagent. */
  delegatedTools: string[]
  /** Optional per-tool data scope narrowing. */
  dataScopes?: Record<string, Record<string, unknown>>
}

export interface ValidatedDelegation {
  /** Effective tools the subagent may use (intersection of parent tools and delegation). */
  effectiveTools: EffectiveTool[]
  /** Tool refs the parent requested but does not itself possess. */
  denied: string[]
  /** Warnings (e.g. data scope narrowed or widened scope dropped). */
  warnings: string[]
}

/**
 * Validate a delegation request from a parent agent to a subagent.
 *
 * Resolves the parent's effective tools, intersects with the requested
 * delegation, narrows data scopes, and returns the validated result.
 */
export async function validateDelegation(
  parentAgentId: string,
  delegationRequest: DelegationRequest,
  deps: { db: Kysely<Database>; assembler: CapabilityAssembler },
): Promise<ValidatedDelegation> {
  const { delegatedTools, dataScopes } = delegationRequest

  // Empty delegation → subagent gets zero tools (rule 1)
  if (delegatedTools.length === 0) {
    return { effectiveTools: [], denied: [], warnings: [] }
  }

  // Resolve parent's current effective tools
  const parentTools = await deps.assembler.resolveEffectiveTools(parentAgentId)
  const parentToolMap = new Map<string, EffectiveTool>()
  for (const tool of parentTools) {
    parentToolMap.set(tool.toolRef, tool)
  }

  const effectiveTools: EffectiveTool[] = []
  const denied: string[] = []
  const warnings: string[] = []

  for (const toolRef of delegatedTools) {
    const parentTool = parentToolMap.get(toolRef)

    if (!parentTool) {
      // Parent doesn't have this tool — deny (rule 2)
      denied.push(toolRef)
      continue
    }

    // Clone the parent's effective tool for the subagent.
    // Approval policies transfer as-is (rule 3).
    // Rate limits are shared (rule 4) — the subagent's guarded tools will
    // query the same capability_audit_log rows keyed by the parent's agentId.
    const delegatedTool: EffectiveTool = {
      toolRef: parentTool.toolRef,
      bindingId: parentTool.bindingId,
      approvalPolicy: parentTool.approvalPolicy,
      approvalCondition: parentTool.approvalCondition,
      rateLimit: parentTool.rateLimit,
      costBudget: parentTool.costBudget,
      dataScope: parentTool.dataScope,
      source: parentTool.source,
      toolDefinition: parentTool.toolDefinition,
    }

    // Data scope narrowing
    if (dataScopes && dataScopes[toolRef]) {
      delegatedTool.dataScope = narrowDataScope(
        parentTool.dataScope,
        dataScopes[toolRef],
        toolRef,
        warnings,
      )
    }

    effectiveTools.push(delegatedTool)
  }

  return { effectiveTools, denied, warnings }
}

/**
 * Narrow a data scope: the subagent's requested scope must be a subset
 * of the parent's scope. Any values not present in the parent scope are
 * dropped with a warning.
 *
 * If the parent has no data scope, the requested scope is ignored (the
 * subagent cannot create scope where none exists).
 */
export function narrowDataScope(
  parentScope: Record<string, unknown> | undefined,
  requestedScope: Record<string, unknown>,
  toolRef: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!parentScope) {
    // Parent has no scope constraints — delegation cannot introduce scope
    // where the parent has none. Use parent's (undefined) scope.
    return undefined
  }

  const narrowed: Record<string, unknown> = {}

  for (const [key, requestedValue] of Object.entries(requestedScope)) {
    const parentValue = parentScope[key]

    if (parentValue === undefined) {
      // Parent doesn't have this scope key — skip with warning
      warnings.push(`data_scope key "${key}" not in parent scope for ${toolRef}, dropped`)
      continue
    }

    // Array scope: intersect
    if (Array.isArray(parentValue) && Array.isArray(requestedValue)) {
      const parentSet = new Set(parentValue as unknown[])
      const intersected = (requestedValue as unknown[]).filter((v) => parentSet.has(v))
      const dropped = (requestedValue as unknown[]).filter((v) => !parentSet.has(v))

      if (dropped.length > 0) {
        warnings.push(
          `data_scope "${key}" narrowed for ${toolRef}: dropped ${JSON.stringify(dropped)}`,
        )
      }

      narrowed[key] = intersected
    } else {
      // Non-array: use parent's value (cannot widen)
      if (JSON.stringify(requestedValue) !== JSON.stringify(parentValue)) {
        warnings.push(`data_scope "${key}" cannot be widened for ${toolRef}, using parent scope`)
      }
      narrowed[key] = parentValue
    }
  }

  // Carry forward any parent scope keys not mentioned in the request
  for (const [key, value] of Object.entries(parentScope)) {
    if (!(key in narrowed)) {
      narrowed[key] = value
    }
  }

  return narrowed
}
