import { describe, expect, it } from "vitest"

import { applySkillConstraints, mergeSkillConstraints } from "../skills/constraints.js"
import type { SkillConstraints } from "../skills/types.js"

// ---------------------------------------------------------------------------
// mergeSkillConstraints
// ---------------------------------------------------------------------------

describe("mergeSkillConstraints", () => {
  it("returns default constraints for empty array", () => {
    const result = mergeSkillConstraints([])
    expect(result.allowedTools).toEqual([])
    expect(result.deniedTools).toEqual([])
    expect(result.networkAccess).toBe(false)
    expect(result.shellAccess).toBe(true)
  })

  it("returns single skill constraints unchanged", () => {
    const skill: SkillConstraints = {
      allowedTools: ["Read", "Write"],
      deniedTools: ["Bash"],
      networkAccess: true,
      shellAccess: false,
    }
    const result = mergeSkillConstraints([skill])
    expect(result.allowedTools).toEqual(["Read", "Write"])
    expect(result.deniedTools).toEqual(["Bash"])
    expect(result.networkAccess).toBe(true)
    expect(result.shellAccess).toBe(false)
  })

  it("intersects allowedTools across skills", () => {
    const skill1: SkillConstraints = {
      allowedTools: ["Read", "Write", "Grep"],
      deniedTools: [],
      networkAccess: true,
      shellAccess: true,
    }
    const skill2: SkillConstraints = {
      allowedTools: ["Read", "Grep", "Glob"],
      deniedTools: [],
      networkAccess: true,
      shellAccess: true,
    }
    const result = mergeSkillConstraints([skill1, skill2])
    expect(result.allowedTools.sort()).toEqual(["Grep", "Read"])
  })

  it("unions deniedTools across skills", () => {
    const skill1: SkillConstraints = {
      allowedTools: [],
      deniedTools: ["Bash"],
      networkAccess: true,
      shellAccess: true,
    }
    const skill2: SkillConstraints = {
      allowedTools: [],
      deniedTools: ["Write", "Bash"],
      networkAccess: true,
      shellAccess: true,
    }
    const result = mergeSkillConstraints([skill1, skill2])
    expect(result.deniedTools.sort()).toEqual(["Bash", "Write"])
  })

  it("ANDs networkAccess (all must allow)", () => {
    const skill1: SkillConstraints = {
      allowedTools: [],
      deniedTools: [],
      networkAccess: true,
      shellAccess: true,
    }
    const skill2: SkillConstraints = {
      allowedTools: [],
      deniedTools: [],
      networkAccess: false,
      shellAccess: true,
    }
    expect(mergeSkillConstraints([skill1, skill2]).networkAccess).toBe(false)
    expect(mergeSkillConstraints([skill1, skill1]).networkAccess).toBe(true)
  })

  it("ANDs shellAccess (all must allow)", () => {
    const skill1: SkillConstraints = {
      allowedTools: [],
      deniedTools: [],
      networkAccess: true,
      shellAccess: true,
    }
    const skill2: SkillConstraints = {
      allowedTools: [],
      deniedTools: [],
      networkAccess: true,
      shellAccess: false,
    }
    expect(mergeSkillConstraints([skill1, skill2]).shellAccess).toBe(false)
  })

  it("skips skills with empty allowedTools in intersection", () => {
    const skill1: SkillConstraints = {
      allowedTools: ["Read", "Write"],
      deniedTools: [],
      networkAccess: true,
      shellAccess: true,
    }
    const skill2: SkillConstraints = {
      allowedTools: [], // inherits from agent
      deniedTools: [],
      networkAccess: true,
      shellAccess: true,
    }
    const result = mergeSkillConstraints([skill1, skill2])
    // Only skill1 participates in allowedTools intersection
    expect(result.allowedTools).toEqual(["Read", "Write"])
  })
})

// ---------------------------------------------------------------------------
// applySkillConstraints
// ---------------------------------------------------------------------------

describe("applySkillConstraints", () => {
  const baseAgent: SkillConstraints = {
    allowedTools: ["Read", "Write", "Bash", "Grep"],
    deniedTools: [],
    networkAccess: true,
    shellAccess: true,
  }

  it("narrows allowedTools when both specify", () => {
    const skill: SkillConstraints = {
      allowedTools: ["Read", "Grep"],
      deniedTools: [],
      networkAccess: true,
      shellAccess: true,
    }
    const result = applySkillConstraints(baseAgent, skill)
    expect(result.allowedTools.sort()).toEqual(["Grep", "Read"])
  })

  it("uses skill allowedTools when agent has none", () => {
    const agent: SkillConstraints = { ...baseAgent, allowedTools: [] }
    const skill: SkillConstraints = {
      allowedTools: ["Read"],
      deniedTools: [],
      networkAccess: true,
      shellAccess: true,
    }
    const result = applySkillConstraints(agent, skill)
    expect(result.allowedTools).toEqual(["Read"])
  })

  it("keeps agent allowedTools when skill specifies none", () => {
    const skill: SkillConstraints = {
      allowedTools: [],
      deniedTools: [],
      networkAccess: true,
      shellAccess: true,
    }
    const result = applySkillConstraints(baseAgent, skill)
    expect(result.allowedTools).toEqual(baseAgent.allowedTools)
  })

  it("unions deniedTools from both agent and skill", () => {
    const agent: SkillConstraints = { ...baseAgent, deniedTools: ["Bash"] }
    const skill: SkillConstraints = {
      allowedTools: [],
      deniedTools: ["Write"],
      networkAccess: true,
      shellAccess: true,
    }
    const result = applySkillConstraints(agent, skill)
    expect(result.deniedTools.sort()).toEqual(["Bash", "Write"])
  })

  it("deduplicates deniedTools", () => {
    const agent: SkillConstraints = { ...baseAgent, deniedTools: ["Bash"] }
    const skill: SkillConstraints = {
      allowedTools: [],
      deniedTools: ["Bash", "Write"],
      networkAccess: true,
      shellAccess: true,
    }
    const result = applySkillConstraints(agent, skill)
    expect(result.deniedTools.sort()).toEqual(["Bash", "Write"])
  })

  it("ANDs networkAccess — skill cannot widen", () => {
    const agent: SkillConstraints = { ...baseAgent, networkAccess: false }
    const skill: SkillConstraints = {
      allowedTools: [],
      deniedTools: [],
      networkAccess: true,
      shellAccess: true,
    }
    expect(applySkillConstraints(agent, skill).networkAccess).toBe(false)
  })

  it("ANDs shellAccess — skill cannot widen", () => {
    const skill: SkillConstraints = {
      allowedTools: [],
      deniedTools: [],
      networkAccess: true,
      shellAccess: false,
    }
    expect(applySkillConstraints(baseAgent, skill).shellAccess).toBe(false)
  })
})
