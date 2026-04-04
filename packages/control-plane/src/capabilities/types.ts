/**
 * Capability Model Types
 *
 * Core type definitions for the agent capability binding system.
 * An EffectiveTool represents a resolved, executable tool with its
 * binding-level constraints (approval, rate limit, data scope).
 */

import type { ToolDefinition } from "../backends/tool-executor.js"

export type EffectiveToolSourceKind = "builtin" | "mcp" | "webhook" | "unknown"

export interface EffectiveTool {
  /** Qualified tool reference (e.g. 'mcp:slack:chat_postMessage' or 'web_search'). */
  toolRef: string
  /** The agent_tool_binding row ID. */
  bindingId: string
  /** Approval policy from the binding. */
  approvalPolicy: "auto" | "always_approve" | "conditional"
  /** Condition for conditional approval policy. */
  approvalCondition?: Record<string, unknown>
  /** Sliding-window rate limit. */
  rateLimit?: { maxCalls: number; windowSeconds: number }
  /** Cost budget (enforcement deferred). */
  costBudget?: { maxUsd: number; windowSeconds: number }
  /** Tool-specific data scope constraints. */
  dataScope?: Record<string, unknown>
  /** Resolved tool source family. */
  source: { kind: EffectiveToolSourceKind }
  /** The resolved executable tool definition. */
  toolDefinition: ToolDefinition
}

export interface EffectiveToolContract {
  toolRef: string
  runtimeName: string
  description: string
  inputSchema: Record<string, unknown>
  bindingId: string
  approvalPolicy: "auto" | "always_approve" | "conditional"
  approvalCondition: Record<string, unknown> | null
  rateLimit: { maxCalls: number; windowSeconds: number } | null
  costBudget: { maxUsd: number; windowSeconds: number } | null
  dataScope: Record<string, unknown> | null
  source: { kind: EffectiveToolSourceKind }
}
