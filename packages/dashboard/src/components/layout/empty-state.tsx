import Link from "next/link"

interface EmptyStateProps {
  icon: string
  title: string
  description?: string
  actionLabel?: string
  actionHref?: string
  onAction?: () => void
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-surface-border bg-surface-light px-8 py-16 text-center dark:bg-surface-dark">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-primary/10">
        <span className="material-symbols-outlined text-[28px] text-primary">{icon}</span>
      </div>
      <h3 className="text-base font-bold text-text-main dark:text-white">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-text-muted">{description}</p>
      )}
      {actionLabel && actionHref && (
        <Link
          href={actionHref}
          className="mt-5 flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90"
        >
          <span className="material-symbols-outlined text-[16px]">add</span>
          {actionLabel}
        </Link>
      )}
      {actionLabel && onAction && !actionHref && (
        <button
          type="button"
          onClick={onAction}
          className="mt-5 flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition-all hover:bg-primary/90"
        >
          <span className="material-symbols-outlined text-[16px]">add</span>
          {actionLabel}
        </button>
      )}
    </div>
  )
}
