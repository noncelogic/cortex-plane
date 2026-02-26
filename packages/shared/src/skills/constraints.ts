/**
 * Skill constraint merging.
 *
 * Per-skill constraints narrow (never widen) agent-level constraints.
 * When multiple skills are selected, the merged result is the intersection
 * of all skill permissions.
 */

import type { SkillConstraints } from "./types.js"

/**
 * Merge a set of skill constraints into a single effective constraint.
 *
 * Rules:
 * - allowedTools: intersection of all non-empty allowedTools lists.
 *   If a skill specifies no allowedTools, it inherits from the agent.
 * - deniedTools: union of all deniedTools lists.
 * - networkAccess: true only if ALL skills allow it.
 * - shellAccess: true only if ALL skills allow it.
 */
export function mergeSkillConstraints(skills: SkillConstraints[]): SkillConstraints {
  if (skills.length === 0) {
    return {
      allowedTools: [],
      deniedTools: [],
      networkAccess: false,
      shellAccess: true,
    }
  }

  // Start with the first skill's constraints, narrow from there
  let mergedAllowed: Set<string> | null = null
  const mergedDenied = new Set<string>()
  let networkAccess = true
  let shellAccess = true

  for (const skill of skills) {
    // allowedTools: intersect (only skills with non-empty lists participate)
    if (skill.allowedTools.length > 0) {
      const skillSet = new Set(skill.allowedTools)
      if (mergedAllowed === null) {
        mergedAllowed = skillSet
      } else {
        for (const tool of mergedAllowed) {
          if (!skillSet.has(tool)) {
            mergedAllowed.delete(tool)
          }
        }
      }
    }

    // deniedTools: union
    for (const tool of skill.deniedTools) {
      mergedDenied.add(tool)
    }

    // Boolean flags: AND (must be true for all)
    if (!skill.networkAccess) networkAccess = false
    if (!skill.shellAccess) shellAccess = false
  }

  return {
    allowedTools: mergedAllowed ? [...mergedAllowed] : [],
    deniedTools: [...mergedDenied],
    networkAccess,
    shellAccess,
  }
}

/**
 * Apply skill constraints on top of agent-level constraints.
 *
 * Skill constraints can only narrow, never widen:
 * - Agent allowedTools is intersected with skill allowedTools (if specified).
 * - Skill deniedTools are added to agent deniedTools.
 * - networkAccess/shellAccess are ANDed.
 */
export function applySkillConstraints(
  agent: SkillConstraints,
  skill: SkillConstraints,
): SkillConstraints {
  // allowedTools: if skill specifies any, intersect with agent; else keep agent's
  let allowedTools: string[]
  if (skill.allowedTools.length > 0 && agent.allowedTools.length > 0) {
    const skillSet = new Set(skill.allowedTools)
    allowedTools = agent.allowedTools.filter((t) => skillSet.has(t))
  } else if (skill.allowedTools.length > 0) {
    allowedTools = [...skill.allowedTools]
  } else {
    allowedTools = [...agent.allowedTools]
  }

  // deniedTools: union
  const deniedSet = new Set([...agent.deniedTools, ...skill.deniedTools])

  return {
    allowedTools,
    deniedTools: [...deniedSet],
    networkAccess: agent.networkAccess && skill.networkAccess,
    shellAccess: agent.shellAccess && skill.shellAccess,
  }
}
