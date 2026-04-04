"use client"

import "@copilotkit/react-ui/styles.css"

import { CopilotKit } from "@copilotkit/react-core"
import { CopilotChat } from "@copilotkit/react-ui"
import { useCallback, useEffect, useMemo, useState } from "react"

import { QuarantineBanner } from "@/components/agents/quarantine-banner"
import { useToast } from "@/components/layout/toast"
import { useApiQuery } from "@/hooks/use-api"
import {
  clearSession,
  getSessionMessages,
  listAgentSessions,
  resumeSession,
  type Session,
} from "@/lib/api-client"
import { getSessionStorageItem } from "@/lib/browser-storage"

// ---------------------------------------------------------------------------
// CopilotChatPanel — CopilotKit-powered chat UI for the agent detail page
// ---------------------------------------------------------------------------

interface CopilotChatPanelProps {
  agentId: string
}

export function CopilotChatPanel({ agentId }: CopilotChatPanelProps): React.JSX.Element {
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

  const handleSelectSession = useCallback(
    (id: string) => {
      void resumeSession(id)
        .catch(() => undefined)
        .finally(() => {
          setActiveSessionId(id)
          setShowSessions(false)
          void refetchSessions()
        })
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
        addToast("Session closed", "success")
        void refetchSessions()
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to close session"
        setClearError(msg)
        addToast(msg, "error")
      }
    },
    [activeSessionId, refetchSessions, addToast],
  )

  // Load session history for display context
  const [historyReady, setHistoryReady] = useState(false)

  useEffect(() => {
    setHistoryReady(false)
    if (activeSessionId) {
      void getSessionMessages(activeSessionId, { limit: 200 })
        .then(() => {
          // History loaded; CopilotKit manages its own message state
        })
        .catch(() => {
          addToast("Failed to load conversation history", "warning")
        })
        .finally(() => setHistoryReady(true))
    } else {
      setHistoryReady(true)
    }
  }, [activeSessionId, addToast])

  // Build CopilotKit headers: auth + agent context
  const copilotHeaders = useMemo(() => {
    const h: Record<string, string> = { "x-agent-id": agentId }
    const csrf = getSessionStorageItem("cortex_csrf")
    if (csrf) h["x-csrf-token"] = csrf
    const apiKey = process.env.NEXT_PUBLIC_CORTEX_API_KEY
    if (apiKey) h["X-API-Key"] = apiKey
    if (activeSessionId) h["x-session-id"] = activeSessionId
    return h
  }, [agentId, activeSessionId])

  return (
    <div className="copilot-chat-panel flex h-full min-h-[500px] flex-col rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
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

      {/* CopilotKit chat area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {historyReady && (
          <CopilotKit
            key={activeSessionId ?? "new-session"}
            runtimeUrl="/api/copilotkit"
            headers={copilotHeaders}
            showDevConsole={false}
          >
            <CopilotChat
              className="copilot-chat-inner"
              labels={{
                title: "Agent Chat",
                initial: "Send a message to begin chatting with this agent.",
                placeholder: "Type a message...",
              }}
            />
          </CopilotKit>
        )}
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
