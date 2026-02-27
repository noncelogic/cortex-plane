import type { SessionUser } from "@/components/auth-provider"
export { isPublicAuthPath, resolveAuthGuard } from "@/lib/auth-guard"

export function getUserInitials(user: SessionUser | null): string {
  const source = user?.displayName?.trim() || user?.email?.trim() || ""
  if (!source) return "?"

  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length === 1) {
    return (parts[0] ?? "").slice(0, 2).toUpperCase()
  }

  return parts
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase()
}
