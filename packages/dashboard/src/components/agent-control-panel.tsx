"use client"

import { useCallback, useState } from "react"

import {
  dryRunAgent,
  type DryRunResponse,
  killAgent,
  quarantineAgent,
  releaseAgent,
} from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Confirm dialog (reusable within this module)
// ---------------------------------------------------------------------------

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  confirmClass,
  onConfirm,
  onCancel,
  children,
}: {
  title: string
  description: string
  confirmLabel: string
  confirmClass?: string
  onConfirm: () => void
  onCancel: () => void
  children?: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative mx-4 w-full max-w-sm rounded-xl border border-surface-border bg-surface-light p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-red-500/10">
            <span className="material-symbols-outlined text-xl text-red-500">warning</span>
          </div>
          <h3 className="text-lg font-bold text-text-main">{title}</h3>
        </div>
        <p className="mb-4 text-sm text-text-muted">{description}</p>
        {children}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm font-medium text-text-main transition-colors hover:bg-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors ${confirmClass ?? "bg-red-600 hover:bg-red-700"}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AgentControlPanel
// ---------------------------------------------------------------------------

interface AgentControlPanelProps {
  agentId: string
  agentStatus: string
  /** Called after a control action succeeds to refresh parent state */
  onRefresh?: () => void
}

export function AgentControlPanel({
  agentId,
  agentStatus,
  onRefresh,
}: AgentControlPanelProps): React.JSX.Element {
  const [dialog, setDialog] = useState<"kill" | "quarantine" | "release" | "dry-run" | null>(null)
  const [killReason, setKillReason] = useState("")
  const [quarantineReason, setQuarantineReason] = useState("")
  const [dryRunMessage, setDryRunMessage] = useState("")
  const [dryRunResult, setDryRunResult] = useState<DryRunResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isQuarantined = agentStatus === "QUARANTINED"

  const handleKill = useCallback(async () => {
    if (!killReason.trim()) return
    setBusy(true)
    setError(null)
    try {
      await killAgent(agentId, killReason)
      setDialog(null)
      setKillReason("")
      onRefresh?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kill failed")
    } finally {
      setBusy(false)
    }
  }, [agentId, killReason, onRefresh])

  const handleQuarantine = useCallback(async () => {
    if (!quarantineReason.trim()) return
    setBusy(true)
    setError(null)
    try {
      await quarantineAgent(agentId, quarantineReason)
      setDialog(null)
      setQuarantineReason("")
      onRefresh?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Quarantine failed")
    } finally {
      setBusy(false)
    }
  }, [agentId, quarantineReason, onRefresh])

  const handleRelease = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await releaseAgent(agentId, true)
      setDialog(null)
      onRefresh?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Release failed")
    } finally {
      setBusy(false)
    }
  }, [agentId, onRefresh])

  const handleDryRun = useCallback(async () => {
    if (!dryRunMessage.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await dryRunAgent(agentId, dryRunMessage)
      setDryRunResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dry run failed")
    } finally {
      setBusy(false)
    }
  }, [agentId, dryRunMessage])

  return (
    <div className="rounded-xl border border-surface-border bg-surface-light p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="material-symbols-outlined text-lg text-primary">tune</span>
        <h3 className="text-sm font-bold text-text-main">Control Panel</h3>
      </div>

      {error && (
        <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {/* Kill */}
        <button
          type="button"
          onClick={() => {
            setError(null)
            setDialog("kill")
          }}
          disabled={isQuarantined}
          className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs font-bold text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-40"
        >
          <span className="material-symbols-outlined text-sm">dangerous</span>
          Kill
        </button>

        {/* Quarantine / Release */}
        {isQuarantined ? (
          <button
            type="button"
            onClick={() => {
              setError(null)
              setDialog("release")
            }}
            className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs font-bold text-emerald-500 transition-colors hover:bg-emerald-500/10"
          >
            <span className="material-symbols-outlined text-sm">lock_open</span>
            Release
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setError(null)
              setDialog("quarantine")
            }}
            className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs font-bold text-amber-500 transition-colors hover:bg-amber-500/10"
          >
            <span className="material-symbols-outlined text-sm">shield</span>
            Quarantine
          </button>
        )}

        {/* Dry Run */}
        <button
          type="button"
          onClick={() => {
            setError(null)
            setDryRunResult(null)
            setDialog("dry-run")
          }}
          disabled={isQuarantined}
          className="col-span-2 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-bold text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
        >
          <span className="material-symbols-outlined text-sm">science</span>
          Dry Run
        </button>
      </div>

      {/* Kill dialog */}
      {dialog === "kill" && (
        <ConfirmDialog
          title="Kill Agent"
          description="This will immediately cancel the agent's running job and quarantine the agent."
          confirmLabel={busy ? "Killing..." : "Kill Agent"}
          onConfirm={() => void handleKill()}
          onCancel={() => setDialog(null)}
        >
          <input
            type="text"
            placeholder="Reason for kill..."
            value={killReason}
            onChange={(e) => setKillReason(e.target.value)}
            className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted"
          />
        </ConfirmDialog>
      )}

      {/* Quarantine dialog */}
      {dialog === "quarantine" && (
        <ConfirmDialog
          title="Quarantine Agent"
          description="This will freeze the agent and cancel any running job."
          confirmLabel={busy ? "Quarantining..." : "Quarantine"}
          confirmClass="bg-amber-600 hover:bg-amber-700"
          onConfirm={() => void handleQuarantine()}
          onCancel={() => setDialog(null)}
        >
          <input
            type="text"
            placeholder="Reason for quarantine..."
            value={quarantineReason}
            onChange={(e) => setQuarantineReason(e.target.value)}
            className="w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted"
          />
        </ConfirmDialog>
      )}

      {/* Release dialog */}
      {dialog === "release" && (
        <ConfirmDialog
          title="Release Agent"
          description="This will release the agent from quarantine and reset the circuit breaker."
          confirmLabel={busy ? "Releasing..." : "Release"}
          confirmClass="bg-emerald-600 hover:bg-emerald-700"
          onConfirm={() => void handleRelease()}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Dry Run dialog */}
      {dialog === "dry-run" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setDialog(null)}
          />
          <div className="relative mx-4 w-full max-w-lg rounded-xl border border-surface-border bg-surface-light p-6 shadow-2xl">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                <span className="material-symbols-outlined text-xl text-primary">science</span>
              </div>
              <h3 className="text-lg font-bold text-text-main">Dry Run</h3>
            </div>
            <p className="mb-4 text-sm text-text-muted">
              Simulate a single agent turn without executing any tools.
            </p>
            <textarea
              placeholder="Enter a message for the agent..."
              value={dryRunMessage}
              onChange={(e) => setDryRunMessage(e.target.value)}
              rows={3}
              className="mb-4 w-full rounded-lg border border-surface-border bg-surface-dark px-3 py-2 text-sm text-text-main placeholder:text-text-muted"
            />

            {dryRunResult && (
              <div className="mb-4 max-h-60 overflow-y-auto rounded-lg border border-surface-border bg-surface-dark p-3">
                <p className="mb-2 text-xs font-bold text-text-muted">Agent Response:</p>
                <p className="mb-3 whitespace-pre-wrap text-sm text-text-main">
                  {dryRunResult.agentResponse || "(no text response)"}
                </p>
                {dryRunResult.plannedActions.length > 0 && (
                  <>
                    <p className="mb-1 text-xs font-bold text-text-muted">Planned Actions:</p>
                    <ul className="mb-3 space-y-1">
                      {dryRunResult.plannedActions.map((action, i) => (
                        <li key={i} className="font-mono text-xs text-amber-500">
                          {action.toolRef}({JSON.stringify(action.input).slice(0, 100)})
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="flex gap-4 text-[10px] text-text-muted">
                  <span>
                    Tokens: {dryRunResult.tokensUsed.in} in / {dryRunResult.tokensUsed.out} out
                  </span>
                  <span>Est. cost: ${dryRunResult.estimatedCostUsd.toFixed(4)}</span>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDialog(null)}
                className="rounded-lg border border-surface-border px-4 py-2 text-sm font-medium text-text-main transition-colors hover:bg-secondary"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => void handleDryRun()}
                disabled={busy || !dryRunMessage.trim()}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? "Running..." : "Run Simulation"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
