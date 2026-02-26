import { forwardRef, type ButtonHTMLAttributes } from "react"

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"
type ButtonSize = "sm" | "md" | "lg"

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-content hover:bg-primary/90 focus-visible:ring-primary/50",
  secondary:
    "bg-secondary text-text-main hover:bg-secondary/80 focus-visible:ring-secondary/50",
  ghost:
    "bg-transparent text-text-muted hover:bg-secondary hover:text-text-main focus-visible:ring-secondary/50",
  danger:
    "bg-danger text-white hover:bg-danger/90 focus-visible:ring-danger/50",
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs gap-1",
  md: "px-3 py-2 text-sm gap-1.5",
  lg: "px-4 py-2.5 text-base gap-2",
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", size = "md", className = "", children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  ),
)

Button.displayName = "Button"
