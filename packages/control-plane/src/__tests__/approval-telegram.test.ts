import { describe, expect, it } from "vitest"

import {
  parseApprovalCallback,
  buildApprovalCallbackData,
  buildApprovalInlineKeyboard,
  formatApprovalMessage,
  formatDecisionMessage,
} from "../approval/telegram.js"

describe("parseApprovalCallback", () => {
  const uuid = "0192d4e8-b7c6-4f3a-8e1b-5d9f7c2a4e6b"
  const hex = "0192d4e8b7c64f3a8e1b5d9f7c2a4e6b"

  it("parses approve callback", () => {
    const result = parseApprovalCallback(`apr:a:${hex}`)

    expect(result).toEqual({
      action: "a",
      approvalRequestId: uuid,
    })
  })

  it("parses reject callback", () => {
    const result = parseApprovalCallback(`apr:r:${hex}`)

    expect(result).toEqual({
      action: "r",
      approvalRequestId: uuid,
    })
  })

  it("parses details callback", () => {
    const result = parseApprovalCallback(`apr:d:${hex}`)

    expect(result).toEqual({
      action: "d",
      approvalRequestId: uuid,
    })
  })

  it("returns null for non-approval callbacks", () => {
    expect(parseApprovalCallback("other:data")).toBeNull()
    expect(parseApprovalCallback("")).toBeNull()
    expect(parseApprovalCallback("apr:x:invalid")).toBeNull()
  })

  it("returns null for wrong prefix", () => {
    expect(parseApprovalCallback(`foo:a:${hex}`)).toBeNull()
  })

  it("returns null for invalid action character", () => {
    expect(parseApprovalCallback(`apr:x:${hex}`)).toBeNull()
    expect(parseApprovalCallback(`apr:A:${hex}`)).toBeNull()
  })

  it("returns null for invalid hex ID (too short)", () => {
    expect(parseApprovalCallback("apr:a:0192d4e8b7c6")).toBeNull()
  })

  it("returns null for invalid hex characters", () => {
    expect(parseApprovalCallback("apr:a:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull()
  })
})

describe("buildApprovalCallbackData", () => {
  const uuid = "0192d4e8-b7c6-4f3a-8e1b-5d9f7c2a4e6b"
  const hex = "0192d4e8b7c64f3a8e1b5d9f7c2a4e6b"

  it("builds approve callback data", () => {
    expect(buildApprovalCallbackData(uuid, "a")).toBe(`apr:a:${hex}`)
  })

  it("builds reject callback data", () => {
    expect(buildApprovalCallbackData(uuid, "r")).toBe(`apr:r:${hex}`)
  })

  it("builds details callback data", () => {
    expect(buildApprovalCallbackData(uuid, "d")).toBe(`apr:d:${hex}`)
  })

  it("produces data under 64 bytes", () => {
    const data = buildApprovalCallbackData(uuid, "a")
    expect(Buffer.byteLength(data, "utf-8")).toBeLessThanOrEqual(64)
  })

  it("roundtrips through parse", () => {
    const data = buildApprovalCallbackData(uuid, "a")
    const parsed = parseApprovalCallback(data)

    expect(parsed).toEqual({
      action: "a",
      approvalRequestId: uuid,
    })
  })
})

describe("buildApprovalInlineKeyboard", () => {
  const uuid = "0192d4e8-b7c6-4f3a-8e1b-5d9f7c2a4e6b"

  it("returns two rows", () => {
    const keyboard = buildApprovalInlineKeyboard(uuid)
    expect(keyboard).toHaveLength(2)
  })

  it("has Approve and Reject on row 1", () => {
    const keyboard = buildApprovalInlineKeyboard(uuid)
    expect(keyboard[0]).toHaveLength(2)
    expect(keyboard[0]![0]!.text).toContain("Approve")
    expect(keyboard[0]![1]!.text).toContain("Reject")
  })

  it("has Details on row 2", () => {
    const keyboard = buildApprovalInlineKeyboard(uuid)
    expect(keyboard[1]).toHaveLength(1)
    expect(keyboard[1]![0]!.text).toContain("Details")
  })

  it("callback data is parseable", () => {
    const keyboard = buildApprovalInlineKeyboard(uuid)
    const approveData = keyboard[0]![0]!.callbackData
    const rejectData = keyboard[0]![1]!.callbackData
    const detailsData = keyboard[1]![0]!.callbackData

    expect(parseApprovalCallback(approveData)?.action).toBe("a")
    expect(parseApprovalCallback(rejectData)?.action).toBe("r")
    expect(parseApprovalCallback(detailsData)?.action).toBe("d")
  })
})

describe("formatApprovalMessage", () => {
  it("includes agent name, action, and expiry", () => {
    const msg = formatApprovalMessage({
      agentName: "devops-01",
      actionSummary: "Deploy to staging",
      actionType: "deploy_staging",
      jobId: "0192d4e8-b7c6-4f3a-8e1b-5d9f7c2a4e6b",
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    expect(msg).toContain("Approval Required")
    expect(msg).toContain("devops\\-01")
    expect(msg).toContain("deploy\\_staging")
    expect(msg).toContain("Deploy to staging")
    expect(msg).toContain("Expires")
  })
})

describe("formatDecisionMessage", () => {
  it("formats approved decision", () => {
    const msg = formatDecisionMessage({
      decision: "APPROVED",
      decidedBy: "Alice",
      agentName: "devops-01",
      actionSummary: "Deploy to staging",
    })

    expect(msg).toContain("✅")
    expect(msg).toContain("Approved")
    expect(msg).toContain("Alice")
  })

  it("formats rejected decision", () => {
    const msg = formatDecisionMessage({
      decision: "REJECTED",
      decidedBy: "Bob",
      agentName: "devops-01",
      actionSummary: "Deploy to staging",
    })

    expect(msg).toContain("❌")
    expect(msg).toContain("Rejected")
    expect(msg).toContain("Bob")
  })

  it("formats expired decision without by-line", () => {
    const msg = formatDecisionMessage({
      decision: "EXPIRED",
      agentName: "devops-01",
      actionSummary: "Deploy to staging",
    })

    expect(msg).toContain("⏰")
    expect(msg).toContain("Expired")
    expect(msg).not.toContain("by")
  })
})
