"use client"

import { useCallback, useState } from "react"

import { useToast } from "@/components/layout/toast"
import { useModels } from "@/hooks/use-models"
import { createAgent, type CreateAgentRequest } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Available models — keep in sync with control-plane MODEL_CATALOGUE.
// Retained as a static export for backward compatibility (credential-binding,
// tests). Components should prefer the useModels() hook which fetches from
// the GET /models API endpoint.
// ---------------------------------------------------------------------------

export const AVAILABLE_MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gpt-4o", label: "GPT-4o", provider: "openai" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini", provider: "openai" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google-ai-studio" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google-ai-studio" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", provider: "google-ai-studio" },
] as const

interface DeployAgentModalProps {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

export function DeployAgentModal({
  open,
  onClose,
  onSuccess,
}: DeployAgentModalProps): React.JSX.Element | null {
  const { models } = useModels({ credentialAware: true })
  const [name, setName] = useState("")
  const [role, setRole] = useState("")
  const [description, setDescription] = useState("")
  const [model, setModel] = useState("")
  const [systemPrompt, setSystemPrompt] = useState("")

  const { addToast } = useToast()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resetForm = useCallback(() => {
    setName("")
    setRole("")
    setDescription("")
    setModel("")
    setSystemPrompt("")
    setError(null)
  }, [])

  const handleClose = useCallback(() => {
    if (submitting) return
    resetForm()
    onClose()
  }, [submitting, resetForm, onClose])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!name.trim() || !role.trim() || !model.trim() || submitting) return

      setSubmitting(true)
      setError(null)

      try {
        const modelConfig: Record<string, unknown> = {}
        if (model.trim()) modelConfig.model = model.trim()
        if (systemPrompt.trim()) modelConfig.systemPrompt = systemPrompt.trim()

        const body: CreateAgentRequest = {
          name: name.trim(),
          role: role.trim(),
          description: description.trim() || undefined,
          model_config: Object.keys(modelConfig).length > 0 ? modelConfig : undefined,
        }
        await createAgent(body)
        resetForm()
        addToast("Agent deployed successfully", "success")
        onSuccess()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to deploy agent")
      } finally {
        setSubmitting(false)
      }
    },
    [name, role, description, model, systemPrompt, submitting, resetForm, onSuccess],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={handleClose} />

      {/* Dialog */}
      <div className="relative w-full max-h-[100dvh] overflow-y-auto rounded-t-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900 sm:mx-4 sm:max-w-lg sm:rounded-xl">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
              <span className="material-symbols-outlined text-xl text-primary">smart_toy</span>
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">Deploy New Agent</h2>
              <p className="text-xs text-slate-500">Configure and deploy an autonomous agent</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="flex size-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {/* Agent Name */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Agent Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Research Assistant"
              disabled={submitting}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>

          {/* Role / Provider */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Role <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. researcher, code-reviewer, content-writer"
              disabled={submitting}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of this agent's purpose"
              disabled={submitting}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>

          {/* Model */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Model <span className="text-red-500">*</span>
            </label>
            {models.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400">
                <span className="material-symbols-outlined text-[16px]">info</span>
                <span>
                  No models available.{" "}
                  <a
                    href="/settings"
                    className="font-medium text-primary underline hover:text-primary/80"
                  >
                    Connect a provider
                  </a>{" "}
                  to get started.
                </span>
              </div>
            ) : (
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={submitting}
                data-testid="deploy-model-select"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
              >
                <option value="">Select a model...</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Credential warning */}
          {model && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-600 dark:text-amber-400">
              <span className="material-symbols-outlined mt-px text-[16px]">warning</span>
              <span>
                The agent will need a provider credential bound after deployment for the model to
                work. You can bind credentials from the agent detail page.
              </span>
            </div>
          )}

          {/* System Prompt */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
              System Prompt
            </label>
            <textarea
              value={systemPrompt}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setSystemPrompt(e.target.value)
              }
              placeholder="Instructions for the agent's behavior..."
              rows={4}
              disabled={submitting}
              className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-500">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={submitting}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !role.trim() || !model.trim()}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-lg">rocket_launch</span>
              {submitting ? "Deploying..." : "Deploy Agent"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
