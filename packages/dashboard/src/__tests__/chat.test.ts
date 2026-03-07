import { afterEach, describe, expect, it, vi } from "vitest"

import {
  deleteSession,
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
