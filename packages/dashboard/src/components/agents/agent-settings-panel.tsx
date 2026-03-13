"use client"

import { useCallback, useState } from "react"

import { useToast } from "@/components/layout/toast"
import { useModels } from "@/hooks/use-models"
import { type AgentDetail, updateAgent } from "@/lib/api-client"

const CUSTOM_MODEL_VALUE = "__custom__"

export interface AgentSettingsPanelProps {
  agent: AgentDetail
  onSave: () => void
}

export function AgentSettingsPanel({ agent, onSave }: AgentSettingsPanelProps): React.JSX.Element {
  const { models: availableModels } = useModels()
  const { addToast } = useToast()

  const modelConfig: Record<string, unknown> = agent.model_config ?? {}
  const currentModel = typeof modelConfig.model === "string" ? modelConfig.model : ""
  const currentPrompt = typeof modelConfig.systemPrompt === "string" ? modelConfig.systemPrompt : ""

  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(agent.name)
  const [role, setRole] = useState(agent.role)
  const [description, setDescription] = useState(agent.description ?? "")
  const [model, setModel] = useState(currentModel)
  const [customModel, setCustomModel] = useState("")
  const [systemPrompt, setSystemPrompt] = useState(currentPrompt)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isKnownModel = availableModels.some((m) => m.id === currentModel)

  const handleEdit = useCallback(() => {
    setName(agent.name)
    setRole(agent.role)
    setDescription(agent.description ?? "")
    if (isKnownModel || !currentModel) {
      setModel(currentModel)
      setCustomModel("")
    } else {
      setModel(CUSTOM_MODEL_VALUE)
      setCustomModel(currentModel)
    }
    setSystemPrompt(currentPrompt)
    setError(null)
    setEditing(true)
  }, [agent, currentModel, currentPrompt, isKnownModel])

  const handleCancel = useCallback(() => {
    setEditing(false)
    setError(null)
  }, [])

  const resolvedModel = model === CUSTOM_MODEL_VALUE ? customModel.trim() : model.trim()

  const handleSave = useCallback(async () => {
    if (!name.trim() || !role.trim()) {
      setError("Name and role are required")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const newConfig: Record<string, unknown> = { ...modelConfig }
      if (resolvedModel) {
        newConfig.model = resolvedModel
      } else {
        delete newConfig.model
      }
      if (systemPrompt.trim()) {
        newConfig.systemPrompt = systemPrompt.trim()
      } else {
        delete newConfig.systemPrompt
      }

      await updateAgent(agent.id, {
        name: name.trim(),
        role: role.trim(),
        description: description.trim() || null,
        model_config: newConfig,
      })
      setEditing(false)
      addToast("Agent settings saved", "success")
      onSave()
    } catch {
      setError("Failed to save agent settings")
    } finally {
      setSaving(false)
    }
  }, [
    agent.id,
    name,
    role,
    description,
    resolvedModel,
    systemPrompt,
    modelConfig,
    onSave,
    addToast,
  ])

  const handleModelSelect = useCallback((value: string) => {
    setModel(value)
    if (value !== CUSTOM_MODEL_VALUE) {
      setCustomModel("")
    }
  }, [])

  const modelLabel = availableModels.find((m) => m.id === currentModel)?.label

  return (
    <div
      data-testid="agent-settings-panel"
      className="rounded-xl border border-slate-200 bg-white p-5 dark:border-primary/10 dark:bg-primary/5"
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">settings</span>
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
            Agent Settings
          </h3>
        </div>
        {!editing && (
          <button
            onClick={handleEdit}
            data-testid="agent-settings-edit-btn"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
          >
            <span className="material-symbols-outlined text-sm">edit</span>
            Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="space-y-3">
          {/* Name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              disabled={saving}
              data-testid="agent-settings-name"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>

          {/* Role */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              Role <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={role}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRole(e.target.value)}
              disabled={saving}
              data-testid="agent-settings-role"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>

          {/* Description */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
              placeholder="Brief description of this agent"
              disabled={saving}
              data-testid="agent-settings-description"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>

          {/* Model */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">Model</label>
            <select
              value={model}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                handleModelSelect(e.target.value)
              }
              disabled={saving}
              data-testid="agent-settings-model-select"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            >
              <option value="">Select a model...</option>
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value={CUSTOM_MODEL_VALUE}>Custom...</option>
            </select>
            {model === CUSTOM_MODEL_VALUE && (
              <input
                type="text"
                value={customModel}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setCustomModel(e.target.value)
                }
                placeholder="e.g. claude-opus-4-6-thinking"
                disabled={saving}
                data-testid="agent-settings-model-input"
                className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
              />
            )}
          </div>

          {/* System Prompt */}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setSystemPrompt(e.target.value)
              }
              placeholder="Instructions for the agent..."
              rows={5}
              disabled={saving}
              data-testid="agent-settings-prompt"
              className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-primary focus:ring-1 focus:ring-primary dark:border-slate-600 dark:bg-slate-800 dark:text-white"
            />
          </div>

          {error && (
            <p data-testid="agent-settings-error" className="text-xs font-medium text-red-500">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              onClick={handleCancel}
              disabled={saving}
              data-testid="agent-settings-cancel-btn"
              className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              data-testid="agent-settings-save-btn"
              className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">Name</span>
            <span
              data-testid="agent-settings-name-value"
              className="text-right text-xs font-semibold text-slate-700 dark:text-slate-300"
            >
              {agent.name}
            </span>
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">Role</span>
            <span
              data-testid="agent-settings-role-value"
              className="text-right text-xs text-slate-700 dark:text-slate-300"
            >
              {agent.role}
            </span>
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">Description</span>
            <span
              data-testid="agent-settings-description-value"
              className="text-right text-xs text-slate-700 dark:text-slate-300"
            >
              {agent.description || "Not set"}
            </span>
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs font-medium text-slate-500">Model</span>
            <span
              data-testid="agent-settings-model-value"
              className="text-right font-mono text-xs text-slate-700 dark:text-slate-300"
            >
              {currentModel
                ? modelLabel
                  ? `${modelLabel} (${currentModel})`
                  : currentModel
                : "Not set"}
            </span>
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="shrink-0 text-xs font-medium text-slate-500">System Prompt</span>
            <span
              data-testid="agent-settings-prompt-value"
              className="text-right text-xs text-slate-700 dark:text-slate-300"
            >
              {currentPrompt ? <span className="line-clamp-3">{currentPrompt}</span> : "Not set"}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
