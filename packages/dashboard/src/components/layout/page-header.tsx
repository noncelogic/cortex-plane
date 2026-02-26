import Link from "next/link"

interface PageHeaderProps {
  title: string
  backHref?: string
}

export function PageHeader({ title, backHref }: PageHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      {backHref && (
        <Link
          href={backHref}
          className="flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          Back
        </Link>
      )}
      <h1 className="font-display text-2xl font-bold tracking-tight text-text-main">
        {title}
      </h1>
    </div>
  )
}
