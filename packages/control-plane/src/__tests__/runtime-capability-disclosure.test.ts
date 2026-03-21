import type { ExecutionTask } from "@cortex/shared/backends"
import { describe, expect, it } from "vitest"

import { buildRuntimeCapabilityDisclosure } from "../worker/runtime-capability-disclosure.js"

function makeTask(overrides?: Partial<ExecutionTask>): ExecutionTask {
  return {
    id: "task-1",
    jobId: "job-1",
    agentId: "agent-1",
    instruction: {
      prompt: "test",
      goalType: "research",
    },
    context: {
      workspacePath: "/workspace/project",
      systemPrompt: "You are a test agent.",
      memories: [],
      relevantFiles: {},
      environment: {},
    },
    constraints: {
      timeoutMs: 30_000,
      maxTokens: 4096,
      model: "claude-sonnet-4-5",
      allowedTools: [],
      deniedTools: [],
      maxTurns: 1,
      networkAccess: true,
      shellAccess: true,
    },
    ...overrides,
  }
}

describe("runtime capability disclosure", () => {
  it("reports actual MCP and browser tools when runtime tool names are known", () => {
    const disclosure = buildRuntimeCapabilityDisclosure({
      task: makeTask(),
      actualToolNames: ["mcp:filesystem:read_file", "playwright_navigate", "web_search"],
    })

    expect(disclosure).toContain("Workspace root: /workspace/project.")
    expect(disclosure).toContain(
      "Filesystem scope: this run is configured with /workspace/project as its workspace root.",
    )
    expect(disclosure).toContain(
      "MCP tools exposed by Cortex: available (mcp:filesystem:read_file).",
    )
    expect(disclosure).toContain(
      "Browser tools exposed by Cortex: available (playwright_navigate).",
    )
    expect(disclosure).toContain("OS command availability: unknown until verified in this runtime.")
  })

  it("surfaces unknown states when the worker has no runtime tool evidence", () => {
    const disclosure = buildRuntimeCapabilityDisclosure({
      task: makeTask(),
    })

    expect(disclosure).toContain("MCP tools exposed by Cortex: unknown.")
    expect(disclosure).toContain("Browser tools exposed by Cortex: unknown.")
    expect(disclosure).toContain("Exposed tool names: unknown.")
    expect(disclosure).toContain("If a capability is unknown, say it is unknown")
  })

  it("does not bluff about curl or installation when shell access is disabled", () => {
    const disclosure = buildRuntimeCapabilityDisclosure({
      task: makeTask({
        constraints: {
          ...makeTask().constraints,
          shellAccess: false,
          networkAccess: false,
        },
      }),
      actualToolNames: [],
    })

    expect(disclosure).toContain("Network access: unavailable.")
    expect(disclosure).toContain("Shell execution: unavailable.")
    expect(disclosure).toContain("MCP tools exposed by Cortex: unavailable for this run.")
    expect(disclosure).toContain("Browser tools exposed by Cortex: unavailable for this run.")
    expect(disclosure).toContain(
      "OS command availability: unavailable because shell execution is disabled.",
    )
    expect(disclosure).toContain(
      "Do not claim curl, package installation, or arbitrary command access.",
    )
  })
})
