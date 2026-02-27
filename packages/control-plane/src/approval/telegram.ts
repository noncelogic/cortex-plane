export interface TelegramApprovalCallback {
  action: "a" | "r" | "d"
  approvalRequestId: string
}

export function parseApprovalCallback(data: string): TelegramApprovalCallback | null {
  const match = data.match(/^apr:([ard]):([a-f0-9]{32})$/)
  if (!match) return null

  const [, action, hexId] = match
  const uuid = [
    hexId!.slice(0, 8),
    hexId!.slice(8, 12),
    hexId!.slice(12, 16),
    hexId!.slice(16, 20),
    hexId!.slice(20),
  ].join("-")

  return { action: action as "a" | "r" | "d", approvalRequestId: uuid }
}

export function buildApprovalCallbackData(
  approvalRequestId: string,
  action: "a" | "r" | "d",
): string {
  const hex = approvalRequestId.replace(/-/g, "")
  return `apr:${action}:${hex}`
}

export function buildApprovalInlineKeyboard(approvalRequestId: string): {
  text: string
  callbackData: string
}[][] {
  return [
    [
      { text: "✅ Approve", callbackData: buildApprovalCallbackData(approvalRequestId, "a") },
      { text: "❌ Reject", callbackData: buildApprovalCallbackData(approvalRequestId, "r") },
    ],
    [{ text: "📋 Details", callbackData: buildApprovalCallbackData(approvalRequestId, "d") }],
  ]
}

export function formatApprovalMessage(params: {
  agentName: string
  actionSummary: string
  actionType: string
  jobId: string
  expiresAt: Date
  riskLevel?: "P0" | "P1" | "P2" | "P3"
  blastRadius?: string | null
}): string {
  const { agentName, actionSummary, actionType, jobId, expiresAt, riskLevel = "P2", blastRadius } = params

  const expiresIn = formatDuration(expiresAt.getTime() - Date.now())
  const expiresAtStr = expiresAt.toISOString().replace("T", " ").slice(0, 19) + " UTC"
  const riskBadge = riskEmoji(riskLevel)

  return [
    "🔒 *Approval Required*",
    `*Risk:* ${riskBadge} *${riskLevel}*`,
    "",
    `*Agent:* ${escapeMarkdown(agentName)}`,
    `*Action:* ${escapeMarkdown(actionType)}`,
    `*Job:* \\#${jobId.slice(0, 8)}`,
    ...(blastRadius ? [`*Blast Radius:* ${escapeMarkdown(blastRadius)}`] : []),
    "",
    escapeMarkdown(actionSummary),
    "",
    `⏰ Expires: ${expiresIn} (${expiresAtStr})`,
  ].join("\n")
}

export function formatDecisionMessage(params: {
  decision: "APPROVED" | "REJECTED" | "EXPIRED"
  decidedBy?: string
  agentName: string
  actionSummary: string
}): string {
  const { decision, decidedBy, agentName, actionSummary } = params

  const icon = decision === "APPROVED" ? "✅" : decision === "REJECTED" ? "❌" : "⏰"
  const verb = decision === "APPROVED" ? "Approved" : decision === "REJECTED" ? "Rejected" : "Expired"
  const byLine = decision === "EXPIRED" || !decidedBy ? "" : ` by ${escapeMarkdown(decidedBy)}`

  return [
    `${icon} *${verb}${byLine}*`,
    "",
    `*Agent:* ${escapeMarkdown(agentName)}`,
    `*Action:* ${escapeMarkdown(actionSummary)}`,
  ].join("\n")
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0m"
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function riskEmoji(level: "P0" | "P1" | "P2" | "P3"): string {
  switch (level) {
    case "P0":
      return "🛑"
    case "P1":
      return "⚠️"
    case "P2":
      return "🟡"
    case "P3":
      return "🟢"
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&")
}
