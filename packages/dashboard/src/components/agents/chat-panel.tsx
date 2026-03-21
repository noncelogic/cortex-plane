"use client"

import { forwardRef, useCallback, useEffect, useRef, useState } from "react"

import { QuarantineBanner } from "@/components/agents/quarantine-banner"
import { EmptyState } from "@/components/layout/empty-state"
import { useToast } from "@/components/layout/toast"
import { useApiQuery } from "@/hooks/use-api"
import type { ChatMessage } from "@/hooks/use-chat-api"
import { useChatApi } from "@/hooks/use-chat-api"
import { clearSession, listAgentSessions, type Session } from "@/lib/api-client"
import type { ChatMessageStatus } from "@/lib/schemas/chat"

// ---------------------------------------------------------------------------
// ChatPanel — full chat UI for the agent detail page
// ---------------------------------------------------------------------------

interface ChatPanelProps {
  agentId: string
}

export function ChatPanel({ agentId }: ChatPanelProps): React.JSX.Element {
  const { addToast } = useToast()
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [showSessions, setShowSessions] = useState(false)
  const [clearError, setClearError] = useState<string | null>(null)

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

  const handleClearSession = useCallback(
    async (sessionId: string) => {
      setClearError(null)
      try {
        await clearSession(sessionId)
        if (activeSessionId === sessionId) {
          setActiveSessionId(null)
        }
        addToast("Session cleared", "success")
        void refetchSessions()
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to clear session"
        setClearError(msg)
        addToast(msg, "error")
      }
    },
    [activeSessionId, refetchSessions, addToast],
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

      {/* Quarantine banner */}
      <QuarantineBanner agentId={agentId} />
      {/* Clear error banner */}
      {clearError && (
        <div className="flex items-center justify-between border-b border-red-200 bg-red-50 px-4 py-2 dark:border-red-800 dark:bg-red-900/20">
          <span className="text-xs text-red-600 dark:text-red-400">{clearError}</span>
          <button
            onClick={() => setClearError(null)}
            className="ml-2 text-xs font-medium text-red-500 hover:text-red-700 dark:hover:text-red-300"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Session list dropdown */}
      {showSessions && (
        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          loading={sessionsLoading}
          onSelect={handleSelectSession}
          onClear={(id) => void handleClearSession(id)}
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
  onClear,
}: {
  sessions: Session[]
  activeSessionId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onClear: (id: string) => void
}): React.JSX.Element {
  const [confirmClearId, setConfirmClearId] = useState<string | null>(null)

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
          {confirmClearId === session.id ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  onClear(session.id)
                  setConfirmClearId(null)
                }}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20"
              >
                Clear
              </button>
              <button
                onClick={() => setConfirmClearId(null)}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClearId(session.id)}
              className="rounded p-1 text-slate-400 transition-colors hover:text-amber-500"
              title="Clear session history"
              aria-label="Clear session history"
            >
              <span className="material-symbols-outlined text-sm">restart_alt</span>
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ChatConversation — message list + input (uses useChatApi hook)
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
  const { addToast } = useToast()
  const [input, setInput] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)

  const {
    messages,
    sending,
    error,
    loadingHistory,
    sendMessage,
    getRetryText,
    removeMessage,
    inputRef,
  } = useChatApi({ agentId, sessionId, onSessionCreated })

  // Warn on history load failure
  useEffect(() => {
    if (!loadingHistory && sessionId && messages.length === 0) {
      // Only toast if we had a session but got no messages — could be empty or failed
    }
  }, [loadingHistory, sessionId, messages.length])

  // Auto-scroll to bottom
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // Focus input on mount / session change
  useEffect(() => {
    inputRef.current?.focus()
  }, [sessionId, inputRef])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return

    setInput("")
    try {
      await sendMessage(text)
    } catch {
      setInput(text) // restore input on error
      addToast("Failed to send message", "error")
    }
    inputRef.current?.focus()
  }, [input, sending, sendMessage, inputRef, addToast])

  const handleRetry = useCallback(
    (errorMsgId: string) => {
      const text = getRetryText(errorMsgId)
      if (!text) return

      removeMessage(errorMsgId)
      setInput(text)

      // Auto-send after a tick
      setTimeout(() => {
        const textarea = inputRef.current
        if (textarea) {
          const enterEvent = new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
          })
          textarea.dispatchEvent(enterEvent)
        }
      }, 100)
    },
    [getRetryText, removeMessage, inputRef],
  )

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
            <MessageBubble key={msg.id} message={msg} onRetry={handleRetry} />
          ))}
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
// MessageBubble — renders a single chat message with status indicators
// ---------------------------------------------------------------------------

function MessageBubble({
  message,
  onRetry,
}: {
  message: ChatMessage
  onRetry: (messageId: string) => void
}): React.JSX.Element {
  const isUser = message.role === "user"
  const status = message.messageStatus ?? "complete"
  const isError = status === "error"
  const isApproval = status === "approval-needed"
  const isStreaming = status === "streaming"

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? "rounded-br-md bg-primary text-white"
            : isError
              ? "rounded-bl-md border border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
              : isApproval
                ? "rounded-bl-md border border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
                : "rounded-bl-md bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
        }`}
      >
        {/* Error header */}
        {isError && (
          <div className="mb-1 flex items-center gap-1">
            <span className="material-symbols-outlined text-sm text-red-500 dark:text-red-400">
              error
            </span>
            <span className="text-xs font-semibold text-red-600 dark:text-red-400">Error</span>
          </div>
        )}

        {/* Approval header */}
        {isApproval && (
          <div className="mb-1 flex items-center gap-1">
            <span className="material-symbols-outlined text-sm text-amber-500 dark:text-amber-400">
              gavel
            </span>
            <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">
              Approval Required
            </span>
          </div>
        )}

        {/* Streaming indicator */}
        {isStreaming && !isUser && (
          <div className="mb-2 flex items-center gap-1.5">
            <div className="flex items-center gap-1">
              <span className="inline-block size-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
              <span className="inline-block size-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
              <span className="inline-block size-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
            </div>
          </div>
        )}

        {/* Message content */}
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>

        {/* Footer: timestamp + status indicator */}
        <div className="mt-1 flex items-center gap-1.5">
          <p
            className={`text-[10px] ${
              isUser
                ? "text-white/60"
                : isError
                  ? "text-red-400 dark:text-red-500"
                  : isApproval
                    ? "text-amber-400 dark:text-amber-500"
                    : "text-slate-400"
            }`}
          >
            {new Date(message.created_at).toLocaleTimeString("en-US", {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
          {/* User message status indicators */}
          {isUser && <MessageStatusIcon status={status} />}
        </div>

        {/* Retry button for error messages */}
        {isError && (
          <button
            onClick={() => onRetry(message.id)}
            className="mt-2 flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/30"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
            Retry
          </button>
        )}

        {/* Approval action hint */}
        {isApproval && (
          <p className="mt-2 text-[10px] text-amber-500 dark:text-amber-400">
            Visit the Jobs tab to approve or reject this action.
          </p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MessageStatusIcon — shows sending/sent/delivered indicators on user messages
// ---------------------------------------------------------------------------

function MessageStatusIcon({ status }: { status: ChatMessageStatus }): React.JSX.Element | null {
  switch (status) {
    case "sending":
      return (
        <span
          className="material-symbols-outlined animate-pulse text-[12px] text-white/50"
          title="Sending..."
        >
          schedule
        </span>
      )
    case "sent":
      return (
        <span className="material-symbols-outlined text-[12px] text-white/60" title="Sent">
          check
        </span>
      )
    case "complete":
      return (
        <span className="material-symbols-outlined text-[12px] text-white/60" title="Delivered">
          done_all
        </span>
      )
    case "error":
      return (
        <span className="material-symbols-outlined text-[12px] text-red-300" title="Failed">
          error_outline
        </span>
      )
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// ChatInput
// ---------------------------------------------------------------------------

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
