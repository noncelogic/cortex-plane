import { describe, expect, it } from "vitest"

import { getAgentStateStyle } from "@/components/agents/agent-status-badge"

describe("AgentStatusBadge style resolver", () => {
  it("returns mapped style for QUARANTINED state", () => {
    const style = getAgentStateStyle("QUARANTINED")
    expect(style.bg).toContain("bg-red-500/10")
  })

  it("returns mapped style for DEGRADED state", () => {
    const style = getAgentStateStyle("DEGRADED")
    expect(style.bg).toContain("bg-amber-500/10")
  })

  it("falls back safely for unknown state (prevents reading .bg crash)", () => {
    const style = getAgentStateStyle("UNKNOWN_STATE")
    expect(style).toMatchObject({
      bg: "bg-slate-500/10",
      text: "text-slate-500 dark:text-slate-400",
      border: "border-slate-500/20",
    })
  })
})
