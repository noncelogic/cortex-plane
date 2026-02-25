/** Animated skeleton placeholder block. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-xl bg-slate-200 dark:bg-slate-800 ${className ?? ""}`} />
  )
}
