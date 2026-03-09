interface PhantomFeatureBannerProps {
  feature: string
  issueUrl?: string
}

/**
 * Informational banner shown on pages whose backend is not yet implemented.
 * Prevents users from mistaking stub UI for broken functionality.
 */
export function PhantomFeatureBanner({
  feature,
  issueUrl,
}: PhantomFeatureBannerProps): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-500/20 bg-slate-500/10 px-5 py-4 text-slate-600 dark:text-slate-400">
      <span className="material-symbols-outlined mt-0.5 text-[20px]">construction</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold">Preview — not yet implemented</p>
        <p className="mt-0.5 text-xs opacity-80">
          {feature} is a planned feature. The UI is a preview of the intended design but the backend
          does not store or process data yet.
          {issueUrl && (
            <>
              {" "}
              <a
                href={issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:opacity-100"
              >
                Track progress
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  )
}
