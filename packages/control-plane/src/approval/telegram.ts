/**
 * Telegram Inline Button Spec for Approval Gates
 *
 * Callback data format: apr:<action>:<request_id_hex>
 * - apr:  4-byte routing prefix
 * - action: a (approve), r (reject), d (details)
 * - request_id_hex: UUID as 32 hex chars (no hyphens)
 *
 * Total: 38 bytes — well within Telegram's 64-byte limit.
 */

export interface TelegramApprovalCallback {
  action: "a" | "r" | "d"
  approvalRequestId: string
}

/**
 * Parse a Telegram callback_data string into an approval action.
 * Returns null if the data doesn't match the approval callback format.
 */
export function parseApprovalCallback(data: string): TelegramApprovalCallback | null {
  const match = data.match(/^apr:([ard]):([a-f0-9]{32})$/)
  if (!match) return null

  const [, action, hexId] = match
  // Convert hex back to UUID format: 8-4-4-4-12
  const uuid = [
    hexId!.slice(0, 8),
    hexId!.slice(8, 12),
    hexId!.slice(12, 16),
    hexId!.slice(16, 20),
    hexId!.slice(20),
  ].join("-")

  return { action: action as "a" | "r" | "d", approvalRequestId: uuid }
}

/**
 * Build callback_data strings for Telegram inline buttons.
 * Strips hyphens from the UUID to fit the compact format.
 */
export function buildApprovalCallbackData(
  approvalRequestId: string,
  action: "a" | "r" | "d",
): string {
  const hex = approvalRequestId.replace(/-/g, "")
  return `apr:${action}:${hex}`
}

/**
 * Build the inline keyboard layout for an approval request.
 * Row 1: [Approve] [Reject]
 * Row 2: [Details]
 */
export function buildApprovalInlineKeyboard(approvalRequestId: string): {
  text: string
  callbackData: string
}[][] {
  return [
    [
      {
        text: "✅ Approve",
        callbackData: buildApprovalCallbackData(approvalRequestId, "a"),
      },
      {
        text: "❌ Reject",
        callbackData: buildApprovalCallbackData(approvalRequestId, "r"),
      },
    ],
    [
      {
        text: "📋 Details",
        callbackData: buildApprovalCallbackData(approvalRequestId, "d"),
      },
    ],
  ]
}

/**
 * Format the approval request notification message text.
 */
export function formatApprovalMessage(params: {
  agentName: string
  actionSummary: string
  actionType: string
  jobId: string
  expiresAt: Date
}): string {
  const { agentName, actionSummary, actionType, jobId, expiresAt } = params

  const expiresIn = formatDuration(expiresAt.getTime() - Date.now())
  const expiresAtStr = expiresAt.toISOString().replace("T", " ").slice(0, 19) + " UTC"

  return [
    "🔒 *Approval Required*",
    "",
    `*Agent:* ${escapeMarkdown(agentName)}`,
    `*Action:* ${escapeMarkdown(actionType)}`,
    `*Job:* \\#${jobId.slice(0, 8)}`,
    "",
    escapeMarkdown(actionSummary),
    "",
    `⏰ Expires: ${expiresIn} (${expiresAtStr})`,
  ].join("\n")
}

/**
 * Format a post-decision message update.
 */
export function formatDecisionMessage(params: {
  decision: "APPROVED" | "REJECTED" | "EXPIRED"
  decidedBy?: string
  agentName: string
  actionSummary: string
}): string {
  const { decision, decidedBy, agentName, actionSummary } = params

  const icon = decision === "APPROVED" ? "✅" : decision === "REJECTED" ? "❌" : "⏰"
  const verb =
    decision === "APPROVED" ? "Approved" : decision === "REJECTED" ? "Rejected" : "Expired"
  const byLine = decision === "EXPIRED" || !decidedBy ? "" : ` by ${escapeMarkdown(decidedBy)}`

  return [
    `${icon} *${verb}${byLine}*`,
    "",
    `*Agent:* ${escapeMarkdown(agentName)}`,
    `*Action:* ${escapeMarkdown(actionSummary)}`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms <= 0) return "0m"
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&")
}
