import Link from "next/link"

interface EmptyStateProps {
  icon: string
  title: string
  description?: string
  actionLabel?: string
  actionHref?: string
  onAction?: () => void
  /** Use compact variant inside sub-components (tables, lists, panels). */
  compact?: boolean
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionHref,
  onAction,
  compact,
}: EmptyStateProps): React.JSX.Element {
  const wrapperClass = compact
    ? "flex flex-col items-center justify-center rounded-xl border border-dashed border-surface-border px-6 py-10 text-center"
    : "flex flex-col items-center justify-center rounded-xl border border-surface-border bg-surface-light px-8 py-16 text-center dark:bg-surface-dark"

  const iconContainerClass = compact
    ? "mb-3 flex size-10 items-center justify-center rounded-full bg-primary/10"
    : "mb-4 flex size-14 items-center justify-center rounded-full bg-primary/10"

  const iconClass = compact
    ? "material-symbols-outlined text-[20px] text-primary"
    : "material-symbols-outlined text-[28px] text-primary"

  const titleClass = compact
    ? "text-sm font-bold text-text-main dark:text-white"
    : "text-base font-bold text-text-main dark:text-white"

  const descClass = compact
    ? "mt-1 max-w-sm text-xs text-text-muted"
    : "mt-1.5 max-w-sm text-sm text-text-muted"

  return (
    <div className={wrapperClass}>
      <div className={iconContainerClass}>
        <span className={iconClass}>{icon}</span>
      </div>
      <h3 className={titleClass}>{title}</h3>
      {description && <p className={descClass}>{description}</p>}
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
