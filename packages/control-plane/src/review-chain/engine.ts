import type {
  BuilderRevisionTask,
  EscalationReason,
  MachineReviewComment,
  ReviewChainResult,
  ReviewLoopRecord,
  ReviewPolicy,
  ReviewStageDefinition,
  ReviewStageOutcome,
  ReviewTaskInput,
  StageExecutor,
} from "./types.js"

/**
 * Policy-driven Builder → Reviewer → Verifier review chain engine.
 */
export class ReviewChainEngine {
  constructor(
    private readonly policyByTaskType: Map<string, ReviewPolicy>,
    private readonly stageExecutor: StageExecutor,
  ) {}

  async run(input: ReviewTaskInput): Promise<ReviewChainResult> {
    const policy = this.policyByTaskType.get(input.taskType)
    if (!policy) {
      throw new Error(`No review policy found for task type: ${input.taskType}`)
    }

    const records: ReviewLoopRecord[] = []

    for (let loop = 1; loop <= policy.maxLoops; loop += 1) {
      const outcomes: ReviewStageOutcome[] = []

      for (const stage of policy.stages) {
        const outcome = await this.stageExecutor.execute(stage, {
          loop,
          input,
          policy,
          priorOutcomes: outcomes,
        })

        outcomes.push(outcome)

        const escalateReason = this.shouldEscalateImmediately(stage, outcome)
        if (escalateReason) {
          records.push({
            loop,
            outcomes,
            revisionTasks: [],
          })

          return {
            passed: false,
            loopsRun: loop,
            records,
            escalatedToHuman: true,
            escalationReason: escalateReason,
          }
        }
      }

      const failingReviewStages = outcomes.filter(
        (o) => !o.pass && this.isReviewStage(policy.stages, o.stageId),
      )

      if (failingReviewStages.length === 0) {
        records.push({ loop, outcomes, revisionTasks: [] })
        return {
          passed: true,
          loopsRun: loop,
          records,
          escalatedToHuman: false,
        }
      }

      const revisionTasks = this.createRevisionTasks(failingReviewStages)
      records.push({ loop, outcomes, revisionTasks })

      if (loop === policy.maxLoops) {
        return {
          passed: false,
          loopsRun: loop,
          records,
          escalatedToHuman: true,
          escalationReason: "max_loops_exceeded",
        }
      }
    }

    return {
      passed: false,
      loopsRun: policy.maxLoops,
      records,
      escalatedToHuman: true,
      escalationReason: "max_loops_exceeded",
    }
  }

  private shouldEscalateImmediately(
    stage: ReviewStageDefinition,
    outcome: ReviewStageOutcome,
  ): EscalationReason | undefined {
    if (outcome.unresolvedConflict) {
      return "unresolved_conflict"
    }

    if (stage.criticalGate && !outcome.pass) {
      return "policy_critical_gate"
    }

    return undefined
  }

  private isReviewStage(stages: ReviewStageDefinition[], stageId: string): boolean {
    const stage = stages.find((s) => s.id === stageId)
    return stage?.role === "REVIEWER" || stage?.role === "VERIFIER"
  }

  private createRevisionTasks(failedOutcomes: ReviewStageOutcome[]): BuilderRevisionTask[] {
    return failedOutcomes.flatMap((outcome) =>
      outcome.comments
        .filter((comment) => this.requiresRemediation(comment))
        .map((comment) => ({
          sourceStageId: outcome.stageId,
          sourceCommentId: comment.id,
          file: comment.file,
          step: comment.step,
          remediation: comment.remediation,
        })),
    )
  }

  private requiresRemediation(comment: MachineReviewComment): boolean {
    return ["warning", "error", "critical"].includes(comment.severity)
  }
}
