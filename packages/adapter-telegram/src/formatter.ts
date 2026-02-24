import type { ApprovalNotification } from "@cortex/shared/channels"

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
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
  const expiresAt = notification.expiresAt.toISOString().replace("T", " ").slice(0, 19) + " UTC"

  return [
    "\u{1f512} <b>Approval Required</b>",
    "",
    `<b>Agent:</b> ${escapeHtml(notification.agentName)}`,
    `<b>Action:</b> ${escapeHtml(notification.actionType)}`,
    `<b>Job:</b> #${escapeHtml(notification.jobId.slice(0, 8))}`,
    "",
    `<code>${escapeHtml(notification.actionDetail)}</code>`,
    "",
    `\u23f0 Expires: ${expiresIn} (${expiresAt})`,
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
      ? "\u{1f7e2}"
      : status.state === "failed"
        ? "\u{1f534}"
        : status.state === "completed"
          ? "\u2705"
          : "\u{1f7e1}"
  const lines = [
    `${icon} <b>Agent Status</b>`,
    "",
    `<b>Agent:</b> ${escapeHtml(status.agentName)}`,
    `<b>Job:</b> #${escapeHtml(status.jobId.slice(0, 8))}`,
    `<b>State:</b> ${escapeHtml(status.state)}`,
  ]
  if (status.detail) {
    lines.push("", `<i>${escapeHtml(status.detail)}</i>`)
  }
  return lines.join("\n")
}
