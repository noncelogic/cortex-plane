"use client"

interface NotificationBellProps {
  count: number
}

export function NotificationBell({ count }: NotificationBellProps): React.JSX.Element {
  return (
    <button
      type="button"
      className="relative rounded-md p-2 text-text-muted hover:bg-secondary hover:text-text-main"
      aria-label={`${count} pending approvals`}
    >
      <span className="text-lg">&#128276;</span>
      {count > 0 && (
        <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-danger text-xs font-bold text-white">
          {count}
        </span>
      )}
    </button>
  )
}
