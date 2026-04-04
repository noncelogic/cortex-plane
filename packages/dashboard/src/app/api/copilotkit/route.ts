import {
  CopilotRuntime,
  type CopilotRuntimeChatCompletionRequest,
  type CopilotRuntimeChatCompletionResponse,
  copilotRuntimeNextJSAppRouterEndpoint,
  type CopilotServiceAdapter,
} from "@copilotkit/runtime"

const CONTROL_PLANE_URL = process.env.CORTEX_API_URL ?? "http://localhost:4000"

export const dynamic = "force-dynamic"

/** Interval for polling job status (ms). */
const JOB_POLL_INTERVAL = 2_000
/** Maximum number of poll attempts before timing out. */
const MAX_POLL_ATTEMPTS = 150

// ---------------------------------------------------------------------------
// CortexChatAdapter — bridges CopilotKit protocol to our control-plane chat API
// ---------------------------------------------------------------------------

class CortexChatAdapter implements CopilotServiceAdapter {
  readonly name = "cortex-chat"

  constructor(
    private readonly agentId: string,
    private readonly authHeaders: Record<string, string>,
  ) {}

  async process(
    request: CopilotRuntimeChatCompletionRequest,
  ): Promise<CopilotRuntimeChatCompletionResponse> {
    const { eventSource, messages } = request

    // Find the latest user TextMessage
    const userTextMessages = messages.filter((m) => m.isTextMessage() && String(m.role) === "user")
    const lastUserMessage = userTextMessages[userTextMessages.length - 1]

    if (!lastUserMessage || !lastUserMessage.isTextMessage()) {
      // eslint-disable-next-line @typescript-eslint/require-await
      await eventSource.stream(async (eventStream$) => {
        const msgId = `msg-${Date.now()}`
        eventStream$.sendTextMessage(msgId, "No message to process.")
      })
      return { threadId: request.threadId ?? `thread-${Date.now()}` }
    }

    const textContent = lastUserMessage.content ?? ""

    if (!textContent) {
      // eslint-disable-next-line @typescript-eslint/require-await
      await eventSource.stream(async (eventStream$) => {
        const msgId = `msg-${Date.now()}`
        eventStream$.sendTextMessage(msgId, "Empty message received.")
      })
      return { threadId: request.threadId ?? `thread-${Date.now()}` }
    }

    // Send message to our control-plane backend
    const sendUrl = `${CONTROL_PLANE_URL}/agents/${this.agentId}/chat?wait=false`
    const requestedSessionId = request.threadId ?? this.authHeaders["x-session-id"]
    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders,
      },
      body: JSON.stringify({
        text: textContent,
        ...(requestedSessionId ? { session_id: requestedSessionId } : {}),
      }),
    })

    if (!sendRes.ok) {
      const errorText = await sendRes.text().catch(() => "Unknown error")
      // eslint-disable-next-line @typescript-eslint/require-await
      await eventSource.stream(async (eventStream$) => {
        const msgId = `msg-${Date.now()}`
        eventStream$.sendTextMessage(msgId, `Error sending message: ${errorText}`)
      })
      return { threadId: request.threadId ?? `thread-${Date.now()}` }
    }

    const sendResult = (await sendRes.json()) as {
      job_id: string
      session_id: string
      status: string
    }

    // Poll for the job result
    const response = await this.pollJob(sendResult.job_id)

    // Stream the response back through CopilotKit's event system
    // eslint-disable-next-line @typescript-eslint/require-await
    await eventSource.stream(async (eventStream$) => {
      const msgId = `msg-${Date.now()}`
      eventStream$.sendTextMessage(msgId, response)
    })

    return {
      threadId: request.threadId ?? sendResult.session_id ?? `thread-${Date.now()}`,
    }
  }

  private async pollJob(jobId: string): Promise<string> {
    const pollUrl = `${CONTROL_PLANE_URL}/agents/${this.agentId}/chat/jobs/${jobId}`
    let attempts = 0

    while (attempts < MAX_POLL_ATTEMPTS) {
      attempts++
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL))

      const res = await fetch(pollUrl, {
        method: "GET",
        headers: this.authHeaders,
      })

      if (!res.ok) continue

      const result = (await res.json()) as {
        status: string
        response?: string
        error?: { message: string; code: string }
        approval_needed?: boolean
      }

      switch (result.status) {
        case "COMPLETED":
          return result.response ?? "Task completed."
        case "FAILED":
        case "TIMED_OUT":
        case "DEAD_LETTER":
          return result.error?.message ?? `Job ${result.status.toLowerCase()}.`
        case "WAITING_FOR_APPROVAL":
          return "This action requires approval. Visit the Jobs tab to approve or reject."
        default:
          // RUNNING, PENDING, etc. — keep polling
          continue
      }
    }

    return "Request timed out waiting for agent response."
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request): Promise<Response> {
  // Extract agent ID and auth headers from the request
  const agentId = req.headers.get("x-agent-id") ?? ""
  const sessionId = req.headers.get("x-session-id")

  // Forward auth-related headers to the control plane
  const authHeaders: Record<string, string> = {}
  const csrf = req.headers.get("x-csrf-token")
  if (csrf) authHeaders["x-csrf-token"] = csrf
  const apiKey = req.headers.get("x-api-key")
  if (apiKey) authHeaders["X-API-Key"] = apiKey
  const cookie = req.headers.get("cookie")
  if (cookie) authHeaders["cookie"] = cookie

  if (sessionId) authHeaders["x-session-id"] = sessionId

  const adapter = new CortexChatAdapter(agentId, authHeaders)

  const runtime = new CopilotRuntime()
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: adapter,
    endpoint: "/api/copilotkit",
  })

  return handleRequest(req)
}
