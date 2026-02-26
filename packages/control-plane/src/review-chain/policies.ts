import type { ReviewChecklistItem, ReviewPolicy, ReviewTaskType } from "./types.js"

function checklistForDefaultStages(): Record<string, ReviewChecklistItem[]> {
  return {
    builder: [
      {
        id: "builder-arch-boundary",
        area: "architecture_boundaries",
        text: "Respect package boundaries and avoid cross-layer leakage.",
        required: true,
      },
      {
        id: "builder-invariants",
        area: "invariants",
        text: "Preserve declared invariants and state transitions.",
        required: true,
      },
      {
        id: "builder-tests",
        area: "tests",
        text: "Add/update tests for behavior changes.",
        required: true,
      },
      {
        id: "builder-docs",
        area: "docs",
        text: "Update docs for externally-visible behavior changes.",
        required: false,
      },
      {
        id: "builder-security",
        area: "security",
        text: "Avoid new credential leaks and privilege expansion.",
        required: true,
      },
    ],
    reviewer: [
      {
        id: "reviewer-arch",
        area: "architecture_boundaries",
        text: "Verify architecture boundaries are respected.",
        required: true,
      },
      {
        id: "reviewer-invariants",
        area: "invariants",
        text: "Verify key invariants are guarded with checks/tests.",
        required: true,
      },
      {
        id: "reviewer-tests",
        area: "tests",
        text: "Validate test quality and regression coverage.",
        required: true,
      },
      {
        id: "reviewer-docs",
        area: "docs",
        text: "Validate docs and changelog alignment.",
        required: false,
      },
      {
        id: "reviewer-security",
        area: "security",
        text: "Review threat and misuse vectors.",
        required: true,
      },
    ],
    verifier: [
      {
        id: "verifier-invariants",
        area: "invariants",
        text: "Final invariant check against expected behavior.",
        required: true,
      },
      {
        id: "verifier-tests",
        area: "tests",
        text: "Verify tests pass and failures are explained.",
        required: true,
      },
      {
        id: "verifier-security",
        area: "security",
        text: "Block policy-critical security regressions.",
        required: true,
      },
    ],
  }
}

export function createDefaultReviewPolicy(taskType: ReviewTaskType): ReviewPolicy {
  const c = checklistForDefaultStages()

  return {
    id: `default-${taskType}`,
    taskType,
    maxLoops: 3,
    escalationLabel: "human-review-required",
    stages: [
      {
        id: "builder",
        role: "BUILDER",
        promptTemplate:
          "You are Builder. Produce implementation changes and concise rationale. Follow checklist strictly.",
        allowedTools: ["read", "write", "edit", "exec"],
        checklist: c.builder,
        passThreshold: 1,
      },
      {
        id: "reviewer",
        role: "REVIEWER",
        promptTemplate:
          "You are Reviewer. Return machine-parseable comments mapped to file + step with remediation.",
        allowedTools: ["read", "exec"],
        deniedTools: ["write", "edit"],
        checklist: c.reviewer,
        passThreshold: 0.85,
      },
      {
        id: "verifier",
        role: "VERIFIER",
        promptTemplate:
          "You are Verifier. Validate checklist closure, policy gates, and block unresolved critical issues.",
        allowedTools: ["read", "exec"],
        deniedTools: ["write", "edit"],
        checklist: c.verifier,
        passThreshold: 0.9,
        criticalGate: true,
      },
    ],
  }
}

export function createPolicyMapByTaskType(taskTypes: ReviewTaskType[]): Map<ReviewTaskType, ReviewPolicy> {
  const map = new Map<ReviewTaskType, ReviewPolicy>()
  for (const taskType of taskTypes) {
    map.set(taskType, createDefaultReviewPolicy(taskType))
  }
  return map
}
