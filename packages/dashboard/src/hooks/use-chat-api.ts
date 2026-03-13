"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  getChatJobStatus,
  getSessionMessages,
  sendChatMessage,
  type SessionMessage,
} from "@/lib/api-client"
import type { ChatMessageStatus } from "@/lib/schemas/chat"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Local message type — extends SessionMessage with status and error tracking. */
export interface ChatMessage extends SessionMessage {
  messageStatus?: ChatMessageStatus
  jobId?: string
  errorMessage?: string
}

export interface UseChatApiReturn {
  messages: ChatMessage[]
  sending: boolean
  error: string | null
  loadingHistory: boolean
  /** Send a user message. Returns the session ID if a new session was created. */
  sendMessage: (text: string) => Promise<void>
  /** Retry a failed message by returning the original user text (caller re-sends). */
  getRetryText: (errorMsgId: string) => string | null
  /** Remove a message by ID. */
  removeMessage: (id: string) => void
  /** Set the input text (used by retry to restore input). */
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}

/** Interval for polling job status (ms). */
const JOB_POLL_INTERVAL = 2_000

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatApi({
  agentId,
  sessionId,
  onSessionCreated,
}: {
  agentId: string
  sessionId: string | null
  onSessionCreated: (sessionId: string) => void
}): UseChatApiReturn {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch history when session changes
  useEffect(() => {
    if (sessionId) {
      setLoadingHistory(true)
      void getSessionMessages(sessionId, { limit: 200 })
        .then((data) => {
          setMessages(data.messages.map((m) => ({ ...m, messageStatus: "complete" as const })))
        })
        .catch(() => {
          // Caller can show a toast — we just clear messages
          setMessages([])
        })
        .finally(() => setLoadingHistory(false))
    } else {
      setMessages([])
    }
  }, [sessionId])

  // Clean up poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    }
  }, [])

  /** Start polling a job for completion. Updates messages as status changes. */
  const startJobPolling = useCallback(
    (jobId: string, pendingMsgId: string, currentSessionId: string) => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)

      pollTimerRef.current = setInterval(() => {
        void getChatJobStatus(agentId, jobId)
          .then((result) => {
            const isTerminal =
              result.status === "COMPLETED" ||
              result.status === "FAILED" ||
              result.status === "TIMED_OUT" ||
              result.status === "DEAD_LETTER" ||
              result.status === "WAITING_FOR_APPROVAL"

            if (result.status === "RUNNING") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pendingMsgId
                    ? { ...m, content: "Agent is thinking...", messageStatus: "streaming" }
                    : m,
                ),
              )
              return
            }

            if (!isTerminal) return

            // Terminal state — stop polling
            if (pollTimerRef.current) {
              clearInterval(pollTimerRef.current)
              pollTimerRef.current = null
            }

            if (result.status === "WAITING_FOR_APPROVAL") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pendingMsgId
                    ? {
                        ...m,
                        content: "This action requires approval before the agent can continue.",
                        messageStatus: "approval-needed",
                        jobId,
                      }
                    : m,
                ),
              )
              setSending(false)
              return
            }

            if (result.response) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pendingMsgId
                    ? {
                        ...m,
                        content: result.response!,
                        messageStatus: "complete",
                        session_id: currentSessionId,
                      }
                    : m,
                ),
              )
            } else if (result.error) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pendingMsgId
                    ? {
                        ...m,
                        content: result.error!.message,
                        messageStatus: "error",
                        errorMessage: result.error!.message,
                        jobId,
                      }
                    : m,
                ),
              )
            } else {
              const fallbackError =
                "Something went wrong processing your message. Please try again."
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === pendingMsgId
                    ? {
                        ...m,
                        content: fallbackError,
                        messageStatus: "error" as const,
                        errorMessage: fallbackError,
                        jobId,
                      }
                    : m,
                ),
              )
            }
            setSending(false)
          })
          .catch(() => {
            // Poll error — will retry on next interval
          })
      }, JOB_POLL_INTERVAL)
    },
    [agentId],
  )

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || sending) return

      setError(null)
      setSending(true)

      // Optimistic user message with "sending" status
      const optimisticMsg: ChatMessage = {
        id: `temp-${Date.now()}`,
        session_id: sessionId ?? "",
        role: "user",
        content: text,
        created_at: new Date().toISOString(),
        messageStatus: "sending",
      }
      setMessages((prev) => [...prev, optimisticMsg])

      try {
        const result = await sendChatMessage(
          agentId,
          { text, session_id: sessionId ?? undefined },
          { wait: false },
        )

        const currentSessionId = result.session_id

        // If a new session was created, notify parent
        if (!sessionId && currentSessionId) {
          onSessionCreated(currentSessionId)
        }

        // Update user message to "sent" status
        setMessages((prev) =>
          prev.map((m) =>
            m.id === optimisticMsg.id
              ? { ...m, messageStatus: "sent", session_id: currentSessionId }
              : m,
          ),
        )

        // Add a pending assistant message placeholder
        const pendingMsgId = `pending-${Date.now()}`
        const pendingMsg: ChatMessage = {
          id: pendingMsgId,
          session_id: currentSessionId,
          role: "assistant",
          content: "Waiting for response...",
          created_at: new Date().toISOString(),
          messageStatus: "streaming",
          jobId: result.job_id,
        }
        setMessages((prev) => [...prev, pendingMsg])

        // Start polling for the job result
        startJobPolling(result.job_id, pendingMsgId, currentSessionId)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send message")
        // Remove optimistic message on error
        setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id))
        setSending(false)
        throw err // Let caller know (e.g. to restore input)
      }
    },
    [sending, agentId, sessionId, onSessionCreated, startJobPolling],
  )

  /** Get the text of the user message preceding an error message (for retry). */
  const getRetryText = useCallback(
    (errorMsgId: string): string | null => {
      const idx = messages.findIndex((m) => m.id === errorMsgId)
      if (idx < 1) return null

      for (let i = idx - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") {
          return messages[i]!.content
        }
      }
      return null
    },
    [messages],
  )

  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id))
  }, [])

  return {
    messages,
    sending,
    error,
    loadingHistory,
    sendMessage,
    getRetryText,
    removeMessage,
    inputRef,
  }
}
