"use client"

import { useCallback, useState } from "react"

import { generatePairingCode } from "@/lib/api-client"

interface PairingCodeModalProps {
  open: boolean
  agentId: string
  onClose: () => void
}

export function PairingCodeModal({
  open,
  agentId,
  onClose,
}: PairingCodeModalProps): React.JSX.Element | null {
  const [code, setCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClose = useCallback(() => {
    setCode(null)
    setExpiresAt(null)
    setCopied(false)
    setError(null)
    onClose()
  }, [onClose])

  const handleGenerate = useCallback(async () => {
    setGenerating(true)
    setError(null)
    try {
      const result = await generatePairingCode(agentId)
      setCode(result.code)
      setExpiresAt(result.expiresAt)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate pairing code")
    } finally {
      setGenerating(false)
    }
  }, [agentId])

  const handleCopy = useCallback(async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select the text
    }
  }, [code])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={handleClose} />

      <div className="relative mx-4 w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
              <span className="material-symbols-outlined text-xl text-primary">link</span>
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                Generate Pairing Code
              </h2>
              <p className="text-xs text-slate-500">Share this code with users to grant access</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="flex size-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* Content */}
        {code ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800">
              <p className="mb-2 text-xs font-medium text-slate-500">Pairing Code</p>
              <div className="flex items-center gap-3">
                <code className="flex-1 text-center font-mono text-2xl font-bold tracking-widest text-slate-900 dark:text-white">
                  {code}
                </code>
                <button
                  onClick={() => void handleCopy()}
                  className="flex size-9 items-center justify-center rounded-lg border border-slate-300 text-slate-500 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
                  title="Copy to clipboard"
                >
                  <span className="material-symbols-outlined text-lg">
                    {copied ? "check" : "content_copy"}
                  </span>
                </button>
              </div>
            </div>
            {expiresAt && (
              <p className="text-center text-xs text-slate-500">
                Expires {new Date(expiresAt).toLocaleString()}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-4">
            <p className="text-center text-sm text-slate-500">
              Generate a one-time code that a user can redeem to gain access to this agent.
            </p>
            <button
              onClick={() => void handleGenerate()}
              disabled={generating}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-lg">add_link</span>
              {generating ? "Generating..." : "Generate Code"}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-500">
            <span className="material-symbols-outlined text-[16px]">error</span>
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
