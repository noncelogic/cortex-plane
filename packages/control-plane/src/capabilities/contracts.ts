import type { ToolDefinition } from "../backends/tool-executor.js"
import type { EffectiveTool, EffectiveToolContract, EffectiveToolSourceKind } from "./types.js"

export interface RuntimeToolManifestToolRecord {
  toolRef: string
  runtimeName: string
  description: string
  inputSchema: Record<string, unknown>
  source: {
    kind: EffectiveToolSourceKind
  }
}

export interface RuntimeToolManifestRecord {
  version: "v1"
  assembledAt: string
  tools: RuntimeToolManifestToolRecord[]
}

function inferSourceKind(toolRef: string): EffectiveToolSourceKind {
  if (toolRef.startsWith("mcp:")) return "mcp"
  if (toolRef.includes("/") || toolRef.includes("::")) return "webhook"
  if (toolRef.length > 0) return "builtin"
  return "unknown"
}

export function isExecutableToolDefinition(value: unknown): value is ToolDefinition {
  if (!value || typeof value !== "object") return false
  const tool = value as Partial<ToolDefinition>
  return (
    typeof tool.name === "string" &&
    tool.name.length > 0 &&
    typeof tool.description === "string" &&
    typeof tool.execute === "function" &&
    typeof tool.inputSchema === "object" &&
    tool.inputSchema !== null
  )
}

export function toEffectiveToolContract(tool: EffectiveTool): EffectiveToolContract {
  return {
    toolRef: tool.toolRef,
    runtimeName: tool.toolDefinition.name,
    description: tool.toolDefinition.description,
    inputSchema: tool.toolDefinition.inputSchema,
    bindingId: tool.bindingId,
    approvalPolicy: tool.approvalPolicy,
    approvalCondition: tool.approvalCondition ?? null,
    rateLimit: tool.rateLimit ?? null,
    costBudget: tool.costBudget ?? null,
    dataScope: tool.dataScope ?? null,
    source: tool.source,
  }
}

export function buildRuntimeToolManifestFromEffectiveTools(
  effectiveTools: EffectiveTool[],
  assembledAt = new Date().toISOString(),
): RuntimeToolManifestRecord {
  const tools = effectiveTools
    .filter((tool) => isExecutableToolDefinition(tool.toolDefinition))
    .map<RuntimeToolManifestToolRecord>((tool) => ({
      toolRef: tool.toolRef,
      runtimeName: tool.toolDefinition.name,
      description: tool.toolDefinition.description,
      inputSchema: tool.toolDefinition.inputSchema,
      source: tool.source,
    }))
    .sort((a, b) => String(a.toolRef).localeCompare(String(b.toolRef)))

  return {
    version: "v1",
    assembledAt,
    tools,
  }
}

export function buildRuntimeToolManifestFromToolDefinitions(
  tools: ToolDefinition[],
  assembledAt = new Date().toISOString(),
): RuntimeToolManifestRecord {
  const manifestTools = tools
    .filter((tool) => isExecutableToolDefinition(tool))
    .map<RuntimeToolManifestToolRecord>((tool) => ({
      toolRef: tool.name,
      runtimeName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      source: { kind: inferSourceKind(tool.name) },
    }))
    .sort((a, b) => String(a.toolRef).localeCompare(String(b.toolRef)))

  return {
    version: "v1",
    assembledAt,
    tools: manifestTools,
  }
}
