import type { ExecutionTask } from "@cortex/shared/backends"

import type { RuntimeToolManifestRecord } from "../capabilities/contracts.js"

type CapabilityState = "available" | "unavailable" | "unknown"

const BROWSER_TOOL_PATTERN = /(browser|playwright|chrome|chromium|cdp)/i

export interface RuntimeCapabilityDisclosureInput {
  task: ExecutionTask
  actualToolNames?: string[]
  runtimeToolManifest?: RuntimeToolManifestRecord
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function summarizeToolNames(names: string[]): string {
  if (names.length === 0) return "none"
  const shown = names.slice(0, 5)
  const suffix = names.length > shown.length ? ` (+${names.length - shown.length} more)` : ""
  return `${shown.join(", ")}${suffix}`
}

function classifyToolState(
  actualToolNames: string[] | undefined,
  predicate: (toolName: string) => boolean,
): { state: CapabilityState; matchingTools: string[] } {
  if (!actualToolNames) {
    return { state: "unknown", matchingTools: [] }
  }

  const matchingTools = actualToolNames.filter(predicate)
  if (matchingTools.length > 0) {
    return { state: "available", matchingTools: uniqueSorted(matchingTools) }
  }

  return { state: "unavailable", matchingTools: [] }
}

function buildMcpLine(actualToolNames: string[] | undefined): string {
  const mcp = classifyToolState(actualToolNames, (toolName) => toolName.startsWith("mcp:"))
  if (mcp.state === "available") {
    return `- MCP tools exposed by Cortex: available (${summarizeToolNames(mcp.matchingTools)}).`
  }
  if (mcp.state === "unavailable") {
    return "- MCP tools exposed by Cortex: unavailable for this run."
  }
  return "- MCP tools exposed by Cortex: unknown."
}

function manifestToToolNames(
  runtimeToolManifest?: RuntimeToolManifestRecord,
): string[] | undefined {
  if (!runtimeToolManifest) return undefined
  return runtimeToolManifest.tools.map((tool) => tool.runtimeName)
}

function buildBrowserLine(actualToolNames: string[] | undefined): string {
  const browser = classifyToolState(actualToolNames, (toolName) =>
    BROWSER_TOOL_PATTERN.test(toolName),
  )
  if (browser.state === "available") {
    return `- Browser tools exposed by Cortex: available (${summarizeToolNames(browser.matchingTools)}).`
  }
  if (browser.state === "unavailable") {
    return "- Browser tools exposed by Cortex: unavailable for this run."
  }
  return "- Browser tools exposed by Cortex: unknown."
}

function buildCommandAvailabilityLine(shellAccess: boolean): string {
  if (!shellAccess) {
    return (
      "- OS command availability: unavailable because shell execution is disabled. " +
      "Do not claim curl, package installation, or arbitrary command access."
    )
  }

  return (
    "- OS command availability: unknown until verified in this runtime. " +
    "Do not claim curl, package installation, or arbitrary filesystem access without evidence."
  )
}

export function listToolNamesFromRegistryLike(registry: {
  list: () => Array<{ name: string }>
}): string[] {
  return uniqueSorted(registry.list().map((tool) => tool.name))
}

export function buildRuntimeCapabilityDisclosure(input: RuntimeCapabilityDisclosureInput): string {
  const manifestNames = manifestToToolNames(input.runtimeToolManifest)
  const actualToolNames = uniqueSorted(input.actualToolNames ?? manifestNames ?? [])
  const knownToolNames =
    input.actualToolNames || input.runtimeToolManifest ? actualToolNames : undefined
  const { task } = input

  const lines = [
    "Runtime capability disclosure:",
    `- Workspace root: ${task.context.workspacePath}.`,
    `- Filesystem scope: this run is configured with ${task.context.workspacePath} as its workspace root. Access outside that workspace is unknown unless verified during execution.`,
    `- Network access: ${task.constraints.networkAccess ? "available" : "unavailable"}.`,
    `- Shell execution: ${task.constraints.shellAccess ? "available" : "unavailable"}.`,
    buildMcpLine(knownToolNames),
    buildBrowserLine(knownToolNames),
    buildCommandAvailabilityLine(task.constraints.shellAccess),
  ]

  if (knownToolNames) {
    lines.push(`- Exposed tool names: ${summarizeToolNames(knownToolNames)}.`)
  } else {
    lines.push("- Exposed tool names: unknown.")
  }

  lines.push("- If a capability is unknown, say it is unknown and verify before claiming it.")

  return lines.join("\n")
}

export function appendRuntimeCapabilityDisclosure(
  systemPrompt: string,
  input: RuntimeCapabilityDisclosureInput,
): string {
  const disclosure = buildRuntimeCapabilityDisclosure(input)
  return systemPrompt.includes("Runtime capability disclosure:")
    ? systemPrompt
    : `${systemPrompt}\n\n${disclosure}`
}
