/**
 * Token budget estimator for skill progressive disclosure.
 *
 * Estimates token cost of skill content to keep context injection
 * within a configurable budget. Uses a simple 4-chars-per-token
 * approximation (conservative for English text + code).
 */

import type { SkillDefinition, SkillMetadata } from "./types.js"

/** Average characters per token (conservative estimate). */
const CHARS_PER_TOKEN = 4

/** Default token budget for skill content injection. */
export const DEFAULT_SKILL_TOKEN_BUDGET = 4_000

/**
 * Estimate token count for a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Estimate token cost of injecting skill summaries into context.
 */
export function estimateSummaryTokens(skills: SkillMetadata[]): number {
  let chars = 0
  for (const skill of skills) {
    // Format: "- **{title}** ({tags}): {summary}\n"
    chars += skill.title.length + skill.tags.join(", ").length + skill.summary.length + 10
  }
  return estimateTokens(String(chars))
}

/**
 * Estimate token cost of injecting full skill definitions.
 */
export function estimateContentTokens(skills: SkillDefinition[]): number {
  let total = 0
  for (const skill of skills) {
    total += estimateTokens(skill.content)
  }
  return total
}

/**
 * Select skills that fit within a token budget, ordered by priority.
 *
 * Skills earlier in the array have higher priority and are selected first.
 * Returns the subset that fits within the budget.
 */
export function selectWithinBudget(
  skills: SkillDefinition[],
  budget: number = DEFAULT_SKILL_TOKEN_BUDGET,
): SkillDefinition[] {
  const selected: SkillDefinition[] = []
  let remaining = budget

  for (const skill of skills) {
    const cost = estimateTokens(skill.content)
    if (cost <= remaining) {
      selected.push(skill)
      remaining -= cost
    }
  }

  return selected
}

/**
 * Format skill summaries for context injection.
 * Returns a compact string listing available skills.
 */
export function formatSkillSummaries(skills: SkillMetadata[]): string {
  if (skills.length === 0) return ""

  const lines = skills.map((s) => `- **${s.title}** [${s.tags.join(", ")}]: ${s.summary}`)
  return `Available skills:\n${lines.join("\n")}`
}

/**
 * Format selected skill instructions for context injection.
 */
export function formatSkillInstructions(skills: SkillDefinition[]): string {
  if (skills.length === 0) return ""

  return skills.map((s) => `## Skill: ${s.metadata.title}\n\n${s.content.trim()}`).join("\n\n")
}
