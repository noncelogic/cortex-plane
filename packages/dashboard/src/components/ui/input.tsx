import { forwardRef, type InputHTMLAttributes } from "react"

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Optional icon name from Material Symbols */
  icon?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ icon, className = "", ...props }, ref) => (
    <div className="relative">
      {icon && (
        <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base text-text-muted">
          {icon}
        </span>
      )}
      <input
        ref={ref}
        className={`w-full rounded-lg border border-surface-border bg-surface-light px-3 py-2 text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 ${icon ? "pl-9" : ""} ${className}`}
        {...props}
      />
    </div>
  ),
)

Input.displayName = "Input"
