import { describe, expect, it } from "vitest"

import { ReviewChainEngine } from "../review-chain/engine.js"
import { createDefaultReviewPolicy } from "../review-chain/policies.js"
import type {
  ReviewPolicy,
  ReviewStageDefinition,
  ReviewStageOutcome,
  ReviewTaskInput,
  StageExecutionContext,
  StageExecutor,
} from "../review-chain/types.js"

class FakeStageExecutor implements StageExecutor {
  constructor(
    private readonly run: (stage: ReviewStageDefinition, context: StageExecutionContext) => ReviewStageOutcome,
  ) {}

  async execute(stage: ReviewStageDefinition, context: StageExecutionContext): Promise<ReviewStageOutcome> {
    return this.run(stage, context)
  }
}

function input(taskType: ReviewTaskInput["taskType"] = "code_edit"): ReviewTaskInput {
  return {
    taskId: "task-123",
    taskType,
    prompt: "Implement feature",
    workspacePath: "/tmp/workspace",
  }
}

function policy(taskType: ReviewTaskInput["taskType"] = "code_edit"): ReviewPolicy {
  return createDefaultReviewPolicy(taskType)
}

describe("ReviewChainEngine", () => {
  it("passes default Builder -> Reviewer -> Verifier chain on first loop", async () => {
    const p = policy()

    const engine = new ReviewChainEngine(
      new Map([[p.taskType, p]]),
      new FakeStageExecutor((stage) => ({
        stageId: stage.id,
        score: 1,
        pass: true,
        comments: [],
        actionableDiffs: [],
      })),
    )

    const result = await engine.run(input())

    expect(result.passed).toBe(true)
    expect(result.escalatedToHuman).toBe(false)
    expect(result.loopsRun).toBe(1)
    expect(result.records[0]?.outcomes.map((o) => o.stageId)).toEqual(["builder", "reviewer", "verifier"])
  })

  it("loops back and creates builder revision tasks from machine-parseable comments", async () => {
    const p = policy()
    const engine = new ReviewChainEngine(
      new Map([[p.taskType, p]]),
      new FakeStageExecutor((stage, context) => {
        if (context.loop === 1 && stage.id === "reviewer") {
          return {
            stageId: stage.id,
            score: 0.5,
            pass: false,
            comments: [
              {
                id: "c-1",
                stageId: stage.id,
                file: "packages/control-plane/src/worker/tasks/agent-execute.ts",
                step: "validate job transition",
                severity: "error",
                message: "Missing guard for invalid transition",
                remediation: "Add explicit status transition check before persisting",
              },
            ],
            actionableDiffs: ["@@ -1,2 +1,5 @@\n+ guard transition"],
          }
        }

        return {
          stageId: stage.id,
          score: 1,
          pass: true,
          comments: [],
          actionableDiffs: [],
        }
      }),
    )

    const result = await engine.run(input())

    expect(result.passed).toBe(true)
    expect(result.loopsRun).toBe(2)

    const firstLoop = result.records[0]
    expect(firstLoop?.revisionTasks).toHaveLength(1)
    expect(firstLoop?.revisionTasks[0]).toMatchObject({
      sourceStageId: "reviewer",
      file: "packages/control-plane/src/worker/tasks/agent-execute.ts",
      step: "validate job transition",
    })
  })

  it("escalates deterministically when max loop count is exceeded", async () => {
    const p = policy()
    const engine = new ReviewChainEngine(
      new Map([[p.taskType, p]]),
      new FakeStageExecutor((stage) => ({
        stageId: stage.id,
        score: stage.id === "reviewer" ? 0.4 : 1,
        pass: stage.id !== "reviewer",
        comments:
          stage.id === "reviewer"
            ? [
                {
                  id: "c-2",
                  stageId: stage.id,
                  file: "README.md",
                  step: "docs check",
                  severity: "warning",
                  message: "docs missing",
                  remediation: "update docs",
                },
              ]
            : [],
        actionableDiffs: [],
      })),
    )

    const result = await engine.run(input())

    expect(result.passed).toBe(false)
    expect(result.escalatedToHuman).toBe(true)
    expect(result.escalationReason).toBe("max_loops_exceeded")
    expect(result.loopsRun).toBe(p.maxLoops)
  })

  it("escalates only for unresolved conflicts or policy-critical gates", async () => {
    const p = policy("security_patch")
    const engine = new ReviewChainEngine(
      new Map([[p.taskType, p]]),
      new FakeStageExecutor((stage) => {
        if (stage.id === "verifier") {
          return {
            stageId: stage.id,
            score: 0.2,
            pass: false,
            comments: [
              {
                id: "c-3",
                stageId: stage.id,
                file: "deploy/k8s/agent/base/networkpolicy.yaml",
                step: "security gate",
                severity: "critical",
                message: "policy-critical egress regression",
                remediation: "restore egress deny rule",
              },
            ],
            actionableDiffs: ["@@ -10,2 +10,0 @@"],
            unresolvedConflict: true,
          }
        }

        return {
          stageId: stage.id,
          score: 1,
          pass: true,
          comments: [],
          actionableDiffs: [],
        }
      }),
    )

    const result = await engine.run(input("security_patch"))

    expect(result.passed).toBe(false)
    expect(result.escalatedToHuman).toBe(true)
    expect(result.escalationReason).toBe("unresolved_conflict")
    expect(result.loopsRun).toBe(1)
  })

  it("supports multi-stage reviewer topology per task type", async () => {
    const p = policy("docs")
    p.stages = [
      p.stages[0],
      {
        ...p.stages[1],
        id: "reviewer-style",
      },
      {
        ...p.stages[1],
        id: "reviewer-facts",
      },
      p.stages[2],
    ]

    const seen: string[] = []

    const engine = new ReviewChainEngine(
      new Map([[p.taskType, p]]),
      new FakeStageExecutor((stage) => {
        seen.push(stage.id)
        return {
          stageId: stage.id,
          score: 1,
          pass: true,
          comments: [],
          actionableDiffs: [],
        }
      }),
    )

    const result = await engine.run(input("docs"))

    expect(result.passed).toBe(true)
    expect(seen).toEqual(["builder", "reviewer-style", "reviewer-facts", "verifier"])
  })
})
