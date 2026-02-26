import type { HTMLAttributes } from "react"

type PanelVariant = "surface" | "chrome" | "inset"

const variantClasses: Record<PanelVariant, string> = {
  surface: "bg-surface-light border border-surface-border rounded-xl",
  chrome: "bg-chrome-bg border border-chrome-border rounded-xl",
  inset: "bg-surface-dark border border-surface-border rounded-xl",
}

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  variant?: PanelVariant
}

export function Panel({
  variant = "surface",
  className = "",
  children,
  ...props
}: PanelProps) {
  return (
    <div className={`${variantClasses[variant]} ${className}`} {...props}>
      {children}
    </div>
  )
}
