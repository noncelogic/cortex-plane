"use client"

export type ViewMode = "table" | "grid"

interface ViewToggleProps {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
}

export function ViewToggle({ mode, onChange }: ViewToggleProps): React.JSX.Element {
  return (
    <div className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      <button
        onClick={() => onChange("table")}
        className={`rounded p-1.5 transition-colors ${
          mode === "table"
            ? "bg-white text-primary shadow-sm dark:bg-slate-700"
            : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
        }`}
        title="List view"
      >
        <span className="material-symbols-outlined text-lg leading-none">format_list_bulleted</span>
      </button>
      <button
        onClick={() => onChange("grid")}
        className={`rounded p-1.5 transition-colors ${
          mode === "grid"
            ? "bg-white text-primary shadow-sm dark:bg-slate-700"
            : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
        }`}
        title="Grid view"
      >
        <span className="material-symbols-outlined text-lg leading-none">grid_view</span>
      </button>
    </div>
  )
}
