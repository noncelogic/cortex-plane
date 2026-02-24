import type { ApprovalNotification } from "@cortex/shared/channels"
import { describe, expect, it, vi } from "vitest"

import { escapeMarkdown, formatAgentStatus, formatApprovalRequest } from "../formatter.js"

describe("escapeMarkdown", () => {
  it("escapes underscores", () => {
    expect(escapeMarkdown("snake_case")).toBe("snake\\_case")
  })

  it("escapes asterisks", () => {
    expect(escapeMarkdown("*bold*")).toBe("\\*bold\\*")
  })

  it("escapes tildes", () => {
    expect(escapeMarkdown("~strikethrough~")).toBe("\\~strikethrough\\~")
  })

  it("escapes backticks", () => {
    expect(escapeMarkdown("`code`")).toBe("\\`code\\`")
  })

  it("escapes pipes", () => {
    expect(escapeMarkdown("a | b")).toBe("a \\| b")
  })

  it("escapes backslashes", () => {
    expect(escapeMarkdown("a\\b")).toBe("a\\\\b")
  })

  it("escapes multiple special characters", () => {
    expect(escapeMarkdown("_*~`|\\")).toBe("\\_\\*\\~\\`\\|\\\\")
  })

  it("returns plain text unchanged", () => {
    expect(escapeMarkdown("hello world")).toBe("hello world")
  })
})

describe("formatApprovalRequest", () => {
  it("produces Discord markdown with approval details", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-02-24T10:00:00Z"))

    const notification: ApprovalNotification = {
      jobId: "abcdef12-3456-7890-abcd-ef1234567890",
      agentName: "devops-01",
      actionType: "Deploy to staging",
      actionDetail: "kubectl apply -f deploy/staging/app.yaml",
      approveCallbackData: "apr:a:abcdef1234567890abcdef1234567890",
      rejectCallbackData: "apr:r:abcdef1234567890abcdef1234567890",
      expiresAt: new Date("2026-02-25T10:00:00Z"),
    }

    const result = formatApprovalRequest(notification)

    expect(result).toContain("**Approval Required**")
    expect(result).toContain("**Agent:** devops-01")
    expect(result).toContain("**Action:** Deploy to staging")
    expect(result).toContain("**Job:** #abcdef12")
    expect(result).toContain("kubectl apply -f deploy/staging/app.yaml")
    expect(result).toContain("24h")
    expect(result).toContain("2026-02-25 10:00:00 UTC")

    vi.useRealTimers()
  })

  it("escapes markdown in user-provided fields", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-02-24T10:00:00Z"))

    const notification: ApprovalNotification = {
      jobId: "abcdef1234567890abcdef1234567890ab",
      agentName: "*bold_agent*",
      actionType: "test~deploy",
      actionDetail: "rm -rf /",
      approveCallbackData: "apr:a:abcdef1234567890abcdef1234567890",
      rejectCallbackData: "apr:r:abcdef1234567890abcdef1234567890",
      expiresAt: new Date("2026-02-24T11:00:00Z"),
    }

    const result = formatApprovalRequest(notification)

    expect(result).toContain("\\*bold\\_agent\\*")
    expect(result).toContain("test\\~deploy")

    vi.useRealTimers()
  })

  it("shows expired for past dates", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-02-25T10:00:00Z"))

    const notification: ApprovalNotification = {
      jobId: "abcdef1234567890abcdef1234567890ab",
      agentName: "agent",
      actionType: "test",
      actionDetail: "detail",
      approveCallbackData: "apr:a:00000000000000000000000000000000",
      rejectCallbackData: "apr:r:00000000000000000000000000000000",
      expiresAt: new Date("2026-02-24T10:00:00Z"),
    }

    const result = formatApprovalRequest(notification)
    expect(result).toContain("expired")

    vi.useRealTimers()
  })
})

describe("formatAgentStatus", () => {
  it("formats running status with green circle", () => {
    const result = formatAgentStatus({
      agentName: "devops-01",
      jobId: "abcdef12-rest",
      state: "running",
    })

    expect(result).toContain("🟢")
    expect(result).toContain("**Agent Status**")
    expect(result).toContain("devops-01")
    expect(result).toContain("running")
  })

  it("formats failed status with red circle", () => {
    const result = formatAgentStatus({
      agentName: "agent",
      jobId: "abcdef12-rest",
      state: "failed",
      detail: "Out of memory",
    })

    expect(result).toContain("🔴")
    expect(result).toContain("Out of memory")
  })

  it("formats completed status with checkmark", () => {
    const result = formatAgentStatus({
      agentName: "agent",
      jobId: "abcdef12-rest",
      state: "completed",
    })

    expect(result).toContain("✅")
  })

  it("formats unknown status with yellow circle", () => {
    const result = formatAgentStatus({
      agentName: "agent",
      jobId: "abcdef12-rest",
      state: "pending",
    })

    expect(result).toContain("🟡")
  })

  it("escapes markdown in status detail", () => {
    const result = formatAgentStatus({
      agentName: "agent",
      jobId: "abcdef12-rest",
      state: "failed",
      detail: "*bold_text*",
    })

    expect(result).toContain("\\*bold\\_text\\*")
  })
})
