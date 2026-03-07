"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { EmptyState } from "@/components/layout/empty-state"
import { useApiQuery } from "@/hooks/use-api"
import {
  deleteSession,
  getSessionMessages,
  listAgentSessions,
  sendChatMessage,
  type Session,
  type SessionMessage,
} from "@/lib/api-client"

// ---------------------------------------------------------------------------
// ChatPanel — full chat UI for the agent detail page
// ---------------------------------------------------------------------------

interface ChatPanelProps {
  agentId: string
}

export function ChatPanel({ agentId }: ChatPanelProps): React.JSX.Element {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [showSessions, setShowSessions] = useState(false)

  // Fetch sessions
  const {
    data: sessionsData,
    isLoading: sessionsLoading,
    refetch: refetchSessions,
  } = useApiQuery(() => listAgentSessions(agentId, { limit: 50 }), [agentId])

  const sessions = sessionsData?.sessions ?? []

  // Auto-select first active session
  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      const active = sessions.find((s) => s.status === "active")
      if (active) setActiveSessionId(active.id)
    }
  }, [sessions, activeSessionId])

  const handleNewSession = useCallback(() => {
    setActiveSessionId(null)
  }, [])

  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id)
    setShowSessions(false)
  }, [])

  const handleSessionCreated = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId)
      void refetchSessions()
    },
    [refetchSessions],
  )

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId)
      if (activeSessionId === sessionId) {
        setActiveSessionId(null)
      }
      void refetchSessions()
    },
    [activeSessionId, refetchSessions],
  )

  return (
    <div className="flex h-full min-h-[500px] flex-col rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">chat</span>
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">Chat</h3>
          {activeSessionId && (
            <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
              {activeSessionId.slice(0, 8)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSessions(!showSessions)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <span className="material-symbols-outlined text-sm">list</span>
            Sessions{sessions.length > 0 ? ` (${sessions.length})` : ""}
          </button>
          <button
            onClick={handleNewSession}
            className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-white transition-colors hover:bg-primary/90"
          >
            <span className="material-symbols-outlined text-sm">add</span>
            New
          </button>
        </div>
      </div>

      {/* Session list dropdown */}
      {showSessions && (
        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          loading={sessionsLoading}
          onSelect={handleSelectSession}
          onDelete={(id) => void handleDeleteSession(id)}
        />
      )}

      {/* Chat area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <ChatConversation
          agentId={agentId}
          sessionId={activeSessionId}
          onSessionCreated={handleSessionCreated}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SessionList
// ---------------------------------------------------------------------------

function SessionList({
  sessions,
  activeSessionId,
  loading,
  onSelect,
  onDelete,
}: {
  sessions: Session[]
  activeSessionId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  if (loading) {
    return (
      <div className="border-b border-slate-200 p-4 dark:border-slate-700">
        <p className="text-xs text-slate-400">Loading sessions...</p>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="border-b border-slate-200 p-4 dark:border-slate-700">
        <p className="text-xs text-slate-500">No sessions yet. Send a message to start one.</p>
      </div>
    )
  }

  return (
    <div className="max-h-48 overflow-y-auto border-b border-slate-200 dark:border-slate-700">
      {sessions.map((session) => (
        <div
          key={session.id}
          className={`flex items-center justify-between px-4 py-2 transition-colors ${
            session.id === activeSessionId
              ? "bg-primary/5 dark:bg-primary/10"
              : "hover:bg-slate-50 dark:hover:bg-slate-800"
          }`}
        >
          <button onClick={() => onSelect(session.id)} className="flex flex-1 items-center gap-2">
            <span
              className={`inline-block size-2 rounded-full ${
                session.status === "active" ? "bg-emerald-500" : "bg-slate-400"
              }`}
            />
            <span className="font-mono text-xs text-slate-600 dark:text-slate-300">
              {session.id.slice(0, 8)}
            </span>
            <span className="text-[10px] text-slate-400">
              {new Date(session.updated_at).toLocaleDateString()}
            </span>
          </button>
          {confirmDeleteId === session.id ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  onDelete(session.id)
                  setConfirmDeleteId(null)
                }}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDeleteId(session.id)}
              className="rounded p-1 text-slate-400 transition-colors hover:text-red-500"
            >
              <span className="material-symbols-outlined text-sm">delete</span>
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ChatConversation — message list + input
// ---------------------------------------------------------------------------

function ChatConversation({
  agentId,
  sessionId,
  onSessionCreated,
}: {
  agentId: string
  sessionId: string | null
  onSessionCreated: (sessionId: string) => void
}): React.JSX.Element {
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Fetch history when session changes
  const [loadingHistory, setLoadingHistory] = useState(false)

  useEffect(() => {
    if (sessionId) {
      setLoadingHistory(true)
      void getSessionMessages(sessionId, { limit: 200 })
        .then((data) => {
          setMessages(data.messages)
        })
        .catch(() => {
          // History load failed — not critical
        })
        .finally(() => setLoadingHistory(false))
    } else {
      setMessages([])
    }
  }, [sessionId])

  // Auto-scroll to bottom
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [sessionId])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return

    setError(null)
    setSending(true)

    // Optimistic user message
    const optimisticMsg: SessionMessage = {
      id: `temp-${Date.now()}`,
      session_id: sessionId ?? "",
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimisticMsg])
    setInput("")

    try {
      const result = await sendChatMessage(
        agentId,
        { text, session_id: sessionId ?? undefined },
        { wait: true, timeout: 60_000 },
      )

      // If a new session was created, notify parent
      if (!sessionId && result.session_id) {
        onSessionCreated(result.session_id)
      }

      // Add assistant response
      if (result.response) {
        const assistantMsg: SessionMessage = {
          id: `resp-${Date.now()}`,
          session_id: result.session_id,
          role: "assistant",
          content: result.response,
          created_at: new Date().toISOString(),
        }
        setMessages((prev) => [...prev, assistantMsg])
      } else if (result.status === "RUNNING" || result.status === "SCHEDULED") {
        // Job still running — show a pending indicator
        const pendingMsg: SessionMessage = {
          id: `pending-${Date.now()}`,
          session_id: result.session_id,
          role: "assistant",
          content: "Processing... (job is still running, refresh to see the response)",
          created_at: new Date().toISOString(),
        }
        setMessages((prev) => [...prev, pendingMsg])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message")
      // Remove optimistic message on error
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id))
      setInput(text) // restore input
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }, [input, sending, agentId, sessionId, onSessionCreated])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        void handleSend()
      }
    },
    [handleSend],
  )

  // Empty state when no session and no messages
  if (!sessionId && messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center p-8">
          <EmptyState
            icon="chat_bubble"
            title="Start a conversation"
            description="Send a message to begin chatting with this agent. A new session will be created automatically."
            compact
          />
        </div>
        <ChatInput
          ref={inputRef}
          value={input}
          onChange={setInput}
          onSend={() => void handleSend()}
          onKeyDown={handleKeyDown}
          sending={sending}
          error={error}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        {loadingHistory && messages.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-slate-400">Loading conversation...</span>
          </div>
        )}
        <div className="space-y-4">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-bl-md bg-slate-100 px-4 py-3 dark:bg-slate-800">
                <div className="flex items-center gap-1">
                  <span className="inline-block size-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
                  <span className="inline-block size-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
                  <span className="inline-block size-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}
        </div>
        <div ref={scrollRef} />
      </div>

      {/* Input */}
      <ChatInput
        ref={inputRef}
        value={input}
        onChange={setInput}
        onSend={() => void handleSend()}
        onKeyDown={handleKeyDown}
        sending={sending}
        error={error}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: SessionMessage }): React.JSX.Element {
  const isUser = message.role === "user"

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? "rounded-br-md bg-primary text-white"
            : "rounded-bl-md bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
        }`}
      >
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
        <p className={`mt-1 text-[10px] ${isUser ? "text-white/60" : "text-slate-400"}`}>
          {new Date(message.created_at).toLocaleTimeString("en-US", {
            hour12: false,
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ChatInput
// ---------------------------------------------------------------------------

import { forwardRef } from "react"

const ChatInput = forwardRef<
  HTMLTextAreaElement,
  {
    value: string
    onChange: (v: string) => void
    onSend: () => void
    onKeyDown: (e: React.KeyboardEvent) => void
    sending: boolean
    error: string | null
  }
>(function ChatInput({ value, onChange, onSend, onKeyDown, sending, error }, ref) {
  return (
    <div className="border-t border-slate-200 p-4 dark:border-slate-700">
      {error && (
        <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a message..."
          rows={1}
          disabled={sending}
          className="flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:placeholder:text-slate-500"
        />
        <button
          onClick={onSend}
          disabled={sending || !value.trim()}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-lg">send</span>
        </button>
      </div>
      <p className="mt-1 text-[10px] text-slate-400">
        Press Enter to send, Shift+Enter for newline
      </p>
    </div>
  )
})
