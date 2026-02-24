import type { ApprovalNotification } from "@cortex/shared/channels"
import { describe, expect, it, vi } from "vitest"

import { escapeHtml, formatAgentStatus, formatApprovalRequest } from "../formatter.js"

describe("escapeHtml", () => {
  it("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b")
  })

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;")
  })

  it("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;")
  })

  it("escapes multiple special characters", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;")
  })

  it("returns plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world")
  })
})

describe("formatApprovalRequest", () => {
  it("produces HTML with approval details", () => {
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

    expect(result).toContain("<b>Approval Required</b>")
    expect(result).toContain("<b>Agent:</b> devops-01")
    expect(result).toContain("<b>Action:</b> Deploy to staging")
    expect(result).toContain("<b>Job:</b> #abcdef12")
    expect(result).toContain("kubectl apply -f deploy/staging/app.yaml")
    expect(result).toContain("24h")
    expect(result).toContain("2026-02-25 10:00:00 UTC")

    vi.useRealTimers()
  })

  it("escapes HTML in user-provided fields", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-02-24T10:00:00Z"))

    const notification: ApprovalNotification = {
      jobId: "abcdef1234567890abcdef1234567890ab",
      agentName: '<script>alert("xss")</script>',
      actionType: "test & deploy",
      actionDetail: "rm -rf /",
      approveCallbackData: "apr:a:abcdef1234567890abcdef1234567890",
      rejectCallbackData: "apr:r:abcdef1234567890abcdef1234567890",
      expiresAt: new Date("2026-02-24T11:00:00Z"),
    }

    const result = formatApprovalRequest(notification)

    expect(result).toContain("&lt;script&gt;")
    expect(result).toContain("test &amp; deploy")
    expect(result).not.toContain("<script>")

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

    expect(result).toContain("\u{1f7e2}")
    expect(result).toContain("<b>Agent Status</b>")
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

    expect(result).toContain("\u{1f534}")
    expect(result).toContain("Out of memory")
  })

  it("formats completed status with checkmark", () => {
    const result = formatAgentStatus({
      agentName: "agent",
      jobId: "abcdef12-rest",
      state: "completed",
    })

    expect(result).toContain("\u2705")
  })

  it("formats unknown status with yellow circle", () => {
    const result = formatAgentStatus({
      agentName: "agent",
      jobId: "abcdef12-rest",
      state: "pending",
    })

    expect(result).toContain("\u{1f7e1}")
  })

  it("escapes HTML in status detail", () => {
    const result = formatAgentStatus({
      agentName: "agent",
      jobId: "abcdef12-rest",
      state: "failed",
      detail: "<b>bad</b>",
    })

    expect(result).toContain("&lt;b&gt;bad&lt;/b&gt;")
  })
})
