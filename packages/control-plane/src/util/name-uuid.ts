/**
 * Deterministic UUID generation from arbitrary strings.
 *
 * Used to convert non-UUID identifiers (e.g. "dev-user", "user-1")
 * into valid UUID v4-shaped strings suitable for PostgreSQL UUID columns.
 */

import { createHash } from "node:crypto"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Derive a deterministic UUID v4-shaped identifier from an arbitrary string.
 * Uses SHA-256, sets version nibble to 4 and variant bits to 10xx.
 */
export function toNameUuid(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex")
  const raw = hex.slice(0, 32)
  const parts = [
    raw.slice(0, 8),
    raw.slice(8, 12),
    "4" + raw.slice(13, 16), // version nibble
    ((parseInt(raw[16]!, 16) & 0x3) | 0x8).toString(16) + raw.slice(17, 20), // variant
    raw.slice(20, 32),
  ]
  return parts.join("-")
}

/**
 * Return the input unchanged if it is already a valid UUID;
 * otherwise derive a deterministic UUID via `toNameUuid`.
 */
export function ensureUuid(raw: string): string {
  return UUID_RE.test(raw) ? raw : toNameUuid(raw)
}
