import { afterEach, describe, expect, it, vi } from "vitest"

import {
  deleteSession,
  getChatJobStatus,
  getSessionMessages,
  listAgentSessions,
  sendChatMessage,
} from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Fetch mock helpers (same pattern as api-client.test.ts)
// ---------------------------------------------------------------------------

function mockFetchResponse(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(body),
    }),
  )
}

const API_BASE = "/api"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Chat & Session API Client", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe("listAgentSessions", () => {
    it("fetches sessions for an agent", async () => {
      const body = {
        sessions: [
          {
            id: "sess-1",
            agent_id: "agent-1",
            user_account_id: "user-1",
            channel_id: "rest:api",
            status: "active",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T01:00:00Z",
          },
        ],
        count: 1,
      }
      mockFetchResponse(body)

      const result = await listAgentSessions("agent-1")

      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0]!.id).toBe("sess-1")
      expect(result.count).toBe(1)

      const url = vi.mocked(fetch).mock.calls[0]![0] as string
      expect(url).toBe(`${API_BASE}/agents/agent-1/sessions`)
    })

    it("passes limit and offset query params", async () => {
      mockFetchResponse({ sessions: [], count: 0 })

      await listAgentSessions("agent-1", { limit: 10, offset: 5 })

      const url = vi.mocked(fetch).mock.calls[0]![0] as string
      expect(url).toContain("limit=10")
      expect(url).toContain("offset=5")
    })
  })

  describe("getSessionMessages", () => {
    it("fetches messages for a session", async () => {
      const body = {
        messages: [
          {
            id: "msg-1",
            session_id: "sess-1",
            role: "user",
            content: "Hello",
            created_at: "2026-03-01T00:00:00Z",
          },
          {
            id: "msg-2",
            session_id: "sess-1",
            role: "assistant",
            content: "Hi there!",
            created_at: "2026-03-01T00:00:01Z",
          },
        ],
        count: 2,
      }
      mockFetchResponse(body)

      const result = await getSessionMessages("sess-1")

      expect(result.messages).toHaveLength(2)
      expect(result.messages[0]!.role).toBe("user")
      expect(result.messages[1]!.role).toBe("assistant")

      const url = vi.mocked(fetch).mock.calls[0]![0] as string
      expect(url).toBe(`${API_BASE}/sessions/sess-1/messages`)
    })

    it("passes limit query param", async () => {
      mockFetchResponse({ messages: [], count: 0 })

      await getSessionMessages("sess-1", { limit: 50 })

      const url = vi.mocked(fetch).mock.calls[0]![0] as string
      expect(url).toContain("limit=50")
    })
  })

  describe("sendChatMessage", () => {
    it("sends a chat message with wait=true", async () => {
      const body = {
        job_id: "job-1",
        session_id: "sess-1",
        status: "COMPLETED",
        response: "Hello from the agent!",
      }
      mockFetchResponse(body)

      const result = await sendChatMessage(
        "agent-1",
        { text: "Hello", session_id: "sess-1" },
        { wait: true, timeout: 30_000 },
      )

      expect(result.job_id).toBe("job-1")
      expect(result.session_id).toBe("sess-1")
      expect(result.response).toBe("Hello from the agent!")

      const [url, opts] = vi.mocked(fetch).mock.calls[0]!
      expect(url).toContain("/agents/agent-1/chat")
      expect(url).toContain("wait=true")
      expect(url).toContain("timeout=30000")
      expect(opts!.method).toBe("POST")
      expect(JSON.parse(opts!.body as string)).toEqual({
        text: "Hello",
        session_id: "sess-1",
      })
    })

    it("sends a chat message without session_id to create new session", async () => {
      const body = {
        job_id: "job-2",
        session_id: "new-sess",
        status: "COMPLETED",
        response: "New session response",
      }
      mockFetchResponse(body)

      const result = await sendChatMessage(
        "agent-1",
        { text: "Start conversation" },
        { wait: true },
      )

      expect(result.session_id).toBe("new-sess")

      const [, opts] = vi.mocked(fetch).mock.calls[0]!
      expect(JSON.parse(opts!.body as string)).toEqual({
        text: "Start conversation",
      })
    })

    it("handles async (non-wait) response", async () => {
      const body = {
        job_id: "job-3",
        session_id: "sess-2",
        status: "SCHEDULED",
      }
      mockFetchResponse(body)

      const result = await sendChatMessage("agent-1", { text: "Hello" })

      expect(result.status).toBe("SCHEDULED")
      expect(result.response).toBeUndefined()
    })

    it("returns error object when job fails", async () => {
      const body = {
        job_id: "job-4",
        session_id: "sess-3",
        status: "FAILED",
        response: null,
        error: {
          message: "This agent does not have an LLM API key configured.",
          code: "job_failed",
        },
      }
      mockFetchResponse(body)

      const result = await sendChatMessage(
        "agent-1",
        { text: "Hello" },
        { wait: true, timeout: 30_000 },
      )

      expect(result.status).toBe("FAILED")
      expect(result.response).toBeNull()
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain("LLM API key")
      expect(result.error!.code).toBe("job_failed")
    })
  })

  describe("getChatJobStatus", () => {
    it("polls job status for a running job", async () => {
      const body = {
        job_id: "job-5",
        session_id: "sess-5",
        status: "RUNNING",
        response: null,
      }
      mockFetchResponse(body)

      const result = await getChatJobStatus("agent-1", "job-5")

      expect(result.status).toBe("RUNNING")
      expect(result.response).toBeNull()

      const url = vi.mocked(fetch).mock.calls[0]![0] as string
      expect(url).toBe(`${API_BASE}/agents/agent-1/chat/jobs/job-5`)
    })

    it("returns completed job with response", async () => {
      const body = {
        job_id: "job-6",
        session_id: "sess-6",
        status: "COMPLETED",
        response: "The agent's response.",
      }
      mockFetchResponse(body)

      const result = await getChatJobStatus("agent-1", "job-6")

      expect(result.status).toBe("COMPLETED")
      expect(result.response).toBe("The agent's response.")
    })

    it("returns WAITING_FOR_APPROVAL status with approval_needed flag", async () => {
      const body = {
        job_id: "job-7",
        session_id: "sess-7",
        status: "WAITING_FOR_APPROVAL",
        response: null,
        approval_needed: true,
      }
      mockFetchResponse(body)

      const result = await getChatJobStatus("agent-1", "job-7")

      expect(result.status).toBe("WAITING_FOR_APPROVAL")
      expect(result.approval_needed).toBe(true)
      expect(result.response).toBeNull()
    })

    it("returns error details for failed job", async () => {
      const body = {
        job_id: "job-8",
        session_id: "sess-8",
        status: "FAILED",
        response: null,
        error: {
          message: "Agent is quarantined due to repeated failures.",
          code: "job_failed",
        },
      }
      mockFetchResponse(body)

      const result = await getChatJobStatus("agent-1", "job-8")

      expect(result.status).toBe("FAILED")
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain("quarantined")
    })

    it("returns error for timed-out job", async () => {
      const body = {
        job_id: "job-9",
        session_id: "sess-9",
        status: "TIMED_OUT",
        response: null,
        error: {
          message: "The request timed out. Please try again.",
          code: "job_timed_out",
        },
      }
      mockFetchResponse(body)

      const result = await getChatJobStatus("agent-1", "job-9")

      expect(result.status).toBe("TIMED_OUT")
      expect(result.error!.code).toBe("job_timed_out")
    })
  })

  describe("deleteSession", () => {
    it("deletes a session", async () => {
      mockFetchResponse({ id: "sess-1", status: "ended" })

      const result = await deleteSession("sess-1")

      expect(result.id).toBe("sess-1")
      expect(result.status).toBe("ended")

      const [url, opts] = vi.mocked(fetch).mock.calls[0]!
      expect(url).toBe(`${API_BASE}/sessions/sess-1`)
      expect(opts!.method).toBe("DELETE")
    })
  })
})

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

import {
  type ChatMessageStatus,
  ChatResponseSchema,
  MessageListResponseSchema,
  SessionDeleteResponseSchema,
  SessionListResponseSchema,
  SessionMessageSchema,
  SessionSchema,
} from "@/lib/schemas/chat"

describe("Chat schemas", () => {
  describe("SessionSchema", () => {
    it("parses a valid session", () => {
      const result = SessionSchema.parse({
        id: "sess-1",
        agent_id: "agent-1",
        user_account_id: "user-1",
        channel_id: "rest:api",
        status: "active",
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-01T01:00:00Z",
      })
      expect(result.id).toBe("sess-1")
      expect(result.status).toBe("active")
    })

    it("allows null/missing optional fields", () => {
      const result = SessionSchema.parse({
        id: "sess-1",
        agent_id: "agent-1",
        status: "active",
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-03-01T01:00:00Z",
      })
      expect(result.user_account_id).toBeUndefined()
    })
  })

  describe("SessionMessageSchema", () => {
    it("parses user message", () => {
      const result = SessionMessageSchema.parse({
        id: "msg-1",
        session_id: "sess-1",
        role: "user",
        content: "Hello",
        created_at: "2026-03-01T00:00:00Z",
      })
      expect(result.role).toBe("user")
    })

    it("parses assistant message", () => {
      const result = SessionMessageSchema.parse({
        id: "msg-2",
        session_id: "sess-1",
        role: "assistant",
        content: "Hi!",
        created_at: "2026-03-01T00:00:00Z",
      })
      expect(result.role).toBe("assistant")
    })

    it("rejects invalid role", () => {
      expect(() =>
        SessionMessageSchema.parse({
          id: "msg-3",
          session_id: "sess-1",
          role: "invalid",
          content: "Hi",
          created_at: "2026-03-01T00:00:00Z",
        }),
      ).toThrow()
    })
  })

  describe("ChatResponseSchema", () => {
    it("parses sync response with content", () => {
      const result = ChatResponseSchema.parse({
        job_id: "job-1",
        session_id: "sess-1",
        status: "COMPLETED",
        response: "Agent reply",
      })
      expect(result.response).toBe("Agent reply")
    })

    it("parses async response without content", () => {
      const result = ChatResponseSchema.parse({
        job_id: "job-1",
        session_id: "sess-1",
        status: "SCHEDULED",
      })
      expect(result.response).toBeUndefined()
    })

    it("parses response with null response field", () => {
      const result = ChatResponseSchema.parse({
        job_id: "job-1",
        session_id: "sess-1",
        status: "COMPLETED",
        response: null,
      })
      expect(result.response).toBeNull()
    })

    it("parses FAILED response with error object", () => {
      const result = ChatResponseSchema.parse({
        job_id: "job-1",
        session_id: "sess-1",
        status: "FAILED",
        response: null,
        error: {
          message: "This agent has been quarantined due to repeated failures.",
          code: "job_failed",
        },
      })
      expect(result.error).toBeDefined()
      expect(result.error!.message).toContain("quarantined")
      expect(result.error!.code).toBe("job_failed")
    })

    it("parses TIMED_OUT response with error object", () => {
      const result = ChatResponseSchema.parse({
        job_id: "job-1",
        session_id: "sess-1",
        status: "TIMED_OUT",
        response: null,
        error: {
          message: "The request timed out. Please try again.",
          code: "job_timed_out",
        },
      })
      expect(result.error!.code).toBe("job_timed_out")
    })

    it("parses successful response without error field", () => {
      const result = ChatResponseSchema.parse({
        job_id: "job-1",
        session_id: "sess-1",
        status: "COMPLETED",
        response: "Agent reply",
      })
      expect(result.error).toBeUndefined()
    })

    it("parses WAITING_FOR_APPROVAL response with approval_needed flag", () => {
      const result = ChatResponseSchema.parse({
        job_id: "job-1",
        session_id: "sess-1",
        status: "WAITING_FOR_APPROVAL",
        response: null,
        approval_needed: true,
      })
      expect(result.status).toBe("WAITING_FOR_APPROVAL")
      expect(result.approval_needed).toBe(true)
    })

    it("parses response without approval_needed (defaults to undefined)", () => {
      const result = ChatResponseSchema.parse({
        job_id: "job-1",
        session_id: "sess-1",
        status: "COMPLETED",
        response: "Reply",
      })
      expect(result.approval_needed).toBeUndefined()
    })
  })

  describe("ChatMessageStatus type", () => {
    it("accepts all valid status values", () => {
      const statuses: ChatMessageStatus[] = [
        "sending",
        "sent",
        "streaming",
        "complete",
        "error",
        "approval-needed",
      ]
      // Type-level check — all values must be assignable
      expect(statuses).toHaveLength(6)
    })
  })

  describe("SessionListResponseSchema", () => {
    it("parses session list", () => {
      const result = SessionListResponseSchema.parse({
        sessions: [
          {
            id: "s1",
            agent_id: "a1",
            status: "active",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
          },
        ],
        count: 1,
      })
      expect(result.sessions).toHaveLength(1)
    })
  })

  describe("MessageListResponseSchema", () => {
    it("parses message list", () => {
      const result = MessageListResponseSchema.parse({
        messages: [
          {
            id: "m1",
            session_id: "s1",
            role: "user",
            content: "Hello",
            created_at: "2026-03-01T00:00:00Z",
          },
        ],
        count: 1,
      })
      expect(result.messages).toHaveLength(1)
    })
  })

  describe("SessionDeleteResponseSchema", () => {
    it("parses delete response", () => {
      const result = SessionDeleteResponseSchema.parse({
        id: "sess-1",
        status: "ended",
      })
      expect(result.status).toBe("ended")
    })

    it("rejects wrong status", () => {
      expect(() =>
        SessionDeleteResponseSchema.parse({
          id: "sess-1",
          status: "active",
        }),
      ).toThrow()
    })
  })
})
