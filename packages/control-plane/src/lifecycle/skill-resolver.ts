/**
 * Skill resolution for agent execution.
 *
 * Resolves which skills should be loaded for a task and builds
 * the ResolvedSkills result with summaries, full content, merged
 * constraints, and token estimates.
 */

import type { ResolvedSkills, SkillIndex } from "@cortex/shared/skills"
import {
  DEFAULT_SKILL_TOKEN_BUDGET,
  estimateContentTokens,
  mergeSkillConstraints,
  selectWithinBudget,
} from "@cortex/shared/skills"

import type { Job } from "../db/types.js"

interface AgentRecord {
  id: string
  name: string
  role: string
  description: string | null
  resource_limits: Record<string, unknown>
}

/**
 * Resolve skills for the current task from the skill index.
 *
 * Selection strategy:
 * 1. Explicit `skills` array in payload → load by name
 * 2. `skillTags` array in payload → match by tags
 * 3. Default → all available skills (within token budget)
 */
export async function loadResolvedSkillsFromIndex(
  skillIndex: SkillIndex,
  agent: AgentRecord,
  job: Job,
): Promise<ResolvedSkills> {
  const payload = job.payload
  const allSkills = skillIndex.getAll()

  const summaries = allSkills.map((s) => ({
    name: s.name,
    title: s.title,
    summary: s.summary,
    tags: s.tags,
  }))

  // Determine which skills to fully load
  let skillNames: string[]

  if (Array.isArray(payload.skills)) {
    skillNames = payload.skills.filter((s): s is string => typeof s === "string")
  } else if (Array.isArray(payload.skillTags)) {
    const tags = payload.skillTags.filter((t): t is string => typeof t === "string")
    skillNames = skillIndex.getByTags(tags).map((s) => s.name)
  } else {
    skillNames = allSkills.map((s) => s.name)
  }

  const fullSkills = await skillIndex.resolve(skillNames)

  // Apply token budget
  const resourceLimits = agent.resource_limits
  const budget =
    typeof resourceLimits.skillTokenBudget === "number"
      ? resourceLimits.skillTokenBudget
      : DEFAULT_SKILL_TOKEN_BUDGET

  const selected = selectWithinBudget(fullSkills, budget)
  const mergedConstraints = mergeSkillConstraints(selected.map((s) => s.metadata.constraints))
  const estimatedTokens = estimateContentTokens(selected)

  return {
    summaries,
    selected,
    mergedConstraints,
    estimatedTokens,
  }
}
