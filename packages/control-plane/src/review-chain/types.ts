export type ReviewStageRole = "BUILDER" | "REVIEWER" | "VERIFIER"

export type ReviewTaskType =
  | "code_edit"
  | "code_generate"
  | "code_review"
  | "security_patch"
  | "docs"

export type ReviewChecklistArea =
  | "architecture_boundaries"
  | "invariants"
  | "tests"
  | "docs"
  | "security"

export type ReviewCommentSeverity = "info" | "warning" | "error" | "critical"

export interface ReviewChecklistItem {
  id: string
  area: ReviewChecklistArea
  text: string
  required: boolean
}

export interface ReviewStageDefinition {
  id: string
  role: ReviewStageRole
  promptTemplate: string
  allowedTools: string[]
  deniedTools?: string[]
  checklist: ReviewChecklistItem[]
  passThreshold: number
  criticalGate?: boolean
}

export interface ReviewPolicy {
  id: string
  taskType: ReviewTaskType
  maxLoops: number
  escalationLabel: string
  stages: ReviewStageDefinition[]
}

export interface ReviewTaskInput {
  taskId: string
  taskType: ReviewTaskType
  prompt: string
  workspacePath: string
}

export interface MachineReviewComment {
  id: string
  stageId: string
  file: string
  step: string
  lineStart?: number
  lineEnd?: number
  severity: ReviewCommentSeverity
  checklistItemId?: string
  message: string
  remediation: string
}

export interface ReviewStageOutcome {
  stageId: string
  score: number
  pass: boolean
  comments: MachineReviewComment[]
  actionableDiffs: string[]
  unresolvedConflict?: boolean
}

export interface BuilderRevisionTask {
  sourceStageId: string
  sourceCommentId: string
  file: string
  step: string
  remediation: string
}

export interface StageExecutionContext {
  loop: number
  input: ReviewTaskInput
  policy: ReviewPolicy
  priorOutcomes: ReviewStageOutcome[]
}

export interface StageExecutor {
  execute(stage: ReviewStageDefinition, context: StageExecutionContext): Promise<ReviewStageOutcome>
}

export interface ReviewLoopRecord {
  loop: number
  outcomes: ReviewStageOutcome[]
  revisionTasks: BuilderRevisionTask[]
}

export type EscalationReason =
  | "policy_critical_gate"
  | "unresolved_conflict"
  | "max_loops_exceeded"

export interface ReviewChainResult {
  passed: boolean
  loopsRun: number
  records: ReviewLoopRecord[]
  escalatedToHuman: boolean
  escalationReason?: EscalationReason
}
