import type { ApprovalNotification } from "@cortex/shared/channels"

export function escapeMarkdown(text: string): string {
  return text.replace(/[_*~`|\\]/g, "\\$&")
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "expired"
  const totalMinutes = Math.floor(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h`
  return `${minutes}m`
}

export function formatApprovalRequest(notification: ApprovalNotification): string {
  const expiresIn = formatDuration(notification.expiresAt.getTime() - Date.now())
  const expiresAt =
    notification.expiresAt.toISOString().replace("T", " ").slice(0, 19) + " UTC"

  return [
    "🔐 **Approval Required**",
    "",
    `**Agent:** ${escapeMarkdown(notification.agentName)}`,
    `**Action:** ${escapeMarkdown(notification.actionType)}`,
    `**Job:** #${notification.jobId.slice(0, 8)}`,
    "",
    `\`${notification.actionDetail}\``,
    "",
    `⏰ Expires: ${expiresIn} (${expiresAt})`,
  ].join("\n")
}

export function formatAgentStatus(status: {
  agentName: string
  jobId: string
  state: string
  detail?: string
}): string {
  const icon =
    status.state === "running"
      ? "🟢"
      : status.state === "failed"
        ? "🔴"
        : status.state === "completed"
          ? "✅"
          : "🟡"

  const lines = [
    `${icon} **Agent Status**`,
    "",
    `**Agent:** ${escapeMarkdown(status.agentName)}`,
    `**Job:** #${status.jobId.slice(0, 8)}`,
    `**State:** ${escapeMarkdown(status.state)}`,
  ]

  if (status.detail) {
    lines.push("", `*${escapeMarkdown(status.detail)}*`)
  }

  return lines.join("\n")
}
