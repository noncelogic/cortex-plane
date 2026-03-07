"use client"

import { Badge } from "@/components/ui/badge"
import { Panel } from "@/components/ui/panel"
import type { ChannelMapping, UserAccount } from "@/lib/api/users"

// ---------------------------------------------------------------------------
// Channel type → icon mapping
// ---------------------------------------------------------------------------

const CHANNEL_ICONS: Record<string, string> = {
  telegram: "send",
  discord: "forum",
  slack: "tag",
  rest: "api",
}

function channelIcon(type: string): string {
  return CHANNEL_ICONS[type] ?? "link"
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface UserIdentityCardProps {
  user: UserAccount
  channels: ChannelMapping[]
}

export function UserIdentityCard({ user, channels }: UserIdentityCardProps) {
  const initials = (user.display_name ?? user.email ?? "?")
    .split(/[\s@]/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("")

  return (
    <Panel className="p-5">
      <div className="flex items-start gap-4">
        {/* Avatar */}
        {user.avatar_url ? (
          <img
            src={user.avatar_url}
            alt={user.display_name ?? "User avatar"}
            className="size-14 rounded-full object-cover ring-2 ring-surface-border"
          />
        ) : (
          <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-lg font-bold text-primary ring-2 ring-surface-border">
            {initials}
          </div>
        )}

        {/* Identity */}
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-lg font-bold text-text-main">
            {user.display_name ?? "Unnamed user"}
          </h2>
          {user.email && <p className="truncate text-sm text-text-muted">{user.email}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={user.role === "admin" ? "danger" : "info"}>{user.role}</Badge>
            {user.oauth_provider && <Badge variant="outline">{user.oauth_provider}</Badge>}
          </div>
        </div>
      </div>

      {/* Linked channels */}
      {channels.length > 0 && (
        <div className="mt-4 border-t border-surface-border pt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
            Linked channels
          </h3>
          <div className="flex flex-wrap gap-2">
            {channels.map((ch) => (
              <span
                key={ch.id}
                className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-2.5 py-1 text-xs text-text-main"
              >
                <span className="material-symbols-outlined text-sm text-primary">
                  {channelIcon(ch.channel_type)}
                </span>
                <span className="font-medium">{ch.channel_type}</span>
                <span className="text-text-muted">{ch.channel_user_id}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Member since */}
      <p className="mt-3 text-xs text-text-muted">
        Member since {new Date(user.created_at).toLocaleDateString()}
      </p>
    </Panel>
  )
}
