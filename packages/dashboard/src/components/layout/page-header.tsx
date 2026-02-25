import Link from "next/link"

interface PageHeaderProps {
  title: string
  backHref?: string
}

export function PageHeader({ title, backHref }: PageHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3">
      {backHref && (
        <Link href={backHref} className="text-sm text-gray-400 hover:text-gray-200">
          &larr; Back
        </Link>
      )}
      <h1 className="text-2xl font-bold text-gray-100">{title}</h1>
    </div>
  )
}
