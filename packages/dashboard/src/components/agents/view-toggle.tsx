"use client"

export type ViewMode = "table" | "grid"

interface ViewToggleProps {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
}

export function ViewToggle({ mode, onChange }: ViewToggleProps): React.JSX.Element {
  return (
    <div className="flex gap-1 rounded-lg bg-secondary p-1">
      <button
        onClick={() => onChange("table")}
        className={`rounded p-1.5 transition-colors ${
          mode === "table"
            ? "bg-surface-light text-primary shadow-sm"
            : "text-text-muted hover:text-text-main"
        }`}
        title="List view"
      >
        <span className="material-symbols-outlined text-lg leading-none">format_list_bulleted</span>
      </button>
      <button
        onClick={() => onChange("grid")}
        className={`rounded p-1.5 transition-colors ${
          mode === "grid"
            ? "bg-surface-light text-primary shadow-sm"
            : "text-text-muted hover:text-text-main"
        }`}
        title="Grid view"
      >
        <span className="material-symbols-outlined text-lg leading-none">grid_view</span>
      </button>
    </div>
  )
}
