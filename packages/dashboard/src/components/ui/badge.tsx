import type { HTMLAttributes } from "react"

type BadgeVariant = "default" | "success" | "warning" | "danger" | "info" | "outline"

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-secondary text-text-main",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  info: "bg-info/10 text-info",
  outline: "border border-surface-border text-text-muted",
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

export function Badge({
  variant = "default",
  className = "",
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {children}
    </span>
  )
}
