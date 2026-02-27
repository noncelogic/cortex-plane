import { describe, expect, it } from "vitest"

import {
  type AuditActorMetadata,
  type AuditEntry,
  buildActorMetadata,
  computeEntryHash,
  createAuditEntry,
  verifyAuditChain,
} from "../approval/audit.js"
import type { Principal } from "../middleware/types.js"

// ---------------------------------------------------------------------------
// buildActorMetadata
// ---------------------------------------------------------------------------

describe("buildActorMetadata", () => {
  const principal: Principal = {
    userId: "user-1",
    displayName: "Alice",
    roles: ["operator", "approver"],
    authMethod: "api_key",
  }

  it("builds metadata from principal and request context", () => {
    const meta = buildActorMetadata(principal, "192.168.1.1", "TestAgent/1.0")

    expect(meta.userId).toBe("user-1")
    expect(meta.displayName).toBe("Alice")
    expect(meta.roles).toEqual(["operator", "approver"])
    expect(meta.authMethod).toBe("api_key")
    expect(meta.ip).toBe("192.168.1.1")
    expect(meta.userAgent).toBe("TestAgent/1.0")
    expect(meta.decidedAt).toBeTruthy()
  })

  it("copies roles array (not a reference)", () => {
    const meta = buildActorMetadata(principal, "127.0.0.1", "agent")
    expect(meta.roles).not.toBe(principal.roles)
    expect(meta.roles).toEqual(principal.roles)
  })
})

// ---------------------------------------------------------------------------
// computeEntryHash
// ---------------------------------------------------------------------------

describe("computeEntryHash", () => {
  const actor: AuditActorMetadata = {
    userId: "user-1",
    displayName: "Alice",
    roles: ["approver"],
    authMethod: "api_key",
    ip: "127.0.0.1",
    userAgent: "test",
    decidedAt: "2025-01-01T00:00:00.000Z",
  }

  it("produces a 64-char hex hash", () => {
    const hash = computeEntryHash("req-1", "APPROVED", actor, "2025-01-01T00:00:00.000Z", null)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("is deterministic", () => {
    const h1 = computeEntryHash("req-1", "APPROVED", actor, "2025-01-01T00:00:00.000Z", null)
    const h2 = computeEntryHash("req-1", "APPROVED", actor, "2025-01-01T00:00:00.000Z", null)
    expect(h1).toBe(h2)
  })

  it("changes when decision changes", () => {
    const h1 = computeEntryHash("req-1", "APPROVED", actor, "2025-01-01T00:00:00.000Z", null)
    const h2 = computeEntryHash("req-1", "REJECTED", actor, "2025-01-01T00:00:00.000Z", null)
    expect(h1).not.toBe(h2)
  })

  it("changes when previousHash changes", () => {
    const h1 = computeEntryHash("req-1", "APPROVED", actor, "2025-01-01T00:00:00.000Z", null)
    const h2 = computeEntryHash("req-1", "APPROVED", actor, "2025-01-01T00:00:00.000Z", "abc123")
    expect(h1).not.toBe(h2)
  })

  it("changes when requestId changes", () => {
    const h1 = computeEntryHash("req-1", "APPROVED", actor, "2025-01-01T00:00:00.000Z", null)
    const h2 = computeEntryHash("req-2", "APPROVED", actor, "2025-01-01T00:00:00.000Z", null)
    expect(h1).not.toBe(h2)
  })
})

// ---------------------------------------------------------------------------
// createAuditEntry
// ---------------------------------------------------------------------------

describe("createAuditEntry", () => {
  const actor: AuditActorMetadata = {
    userId: "user-1",
    displayName: "Alice",
    roles: ["approver"],
    authMethod: "api_key",
    ip: "10.0.0.1",
    userAgent: "curl/7.80",
    decidedAt: "2025-01-15T10:30:00.000Z",
  }

  it("creates entry with null previousHash for first entry", () => {
    const entry = createAuditEntry("req-1", "APPROVED", actor, null)

    expect(entry.requestId).toBe("req-1")
    expect(entry.decision).toBe("APPROVED")
    expect(entry.actor).toEqual(actor)
    expect(entry.previousHash).toBeNull()
    expect(entry.entryHash).toMatch(/^[a-f0-9]{64}$/)
    expect(entry.ip).toBe("10.0.0.1")
    expect(entry.userAgent).toBe("curl/7.80")
  })

  it("chains to previous entry hash", () => {
    const first = createAuditEntry("req-1", "APPROVED", actor, null)
    const second = createAuditEntry("req-2", "REJECTED", actor, first.entryHash)

    expect(second.previousHash).toBe(first.entryHash)
    expect(second.entryHash).not.toBe(first.entryHash)
  })
})

// ---------------------------------------------------------------------------
// verifyAuditChain
// ---------------------------------------------------------------------------

describe("verifyAuditChain", () => {
  const makeActor = (userId: string): AuditActorMetadata => ({
    userId,
    displayName: userId,
    roles: ["approver"],
    authMethod: "api_key",
    ip: "127.0.0.1",
    userAgent: "test",
    decidedAt: new Date().toISOString(),
  })

  it("verifies an empty chain", () => {
    expect(verifyAuditChain([])).toBe(true)
  })

  it("verifies a single entry chain", () => {
    const entry = createAuditEntry("req-1", "APPROVED", makeActor("alice"), null)
    expect(verifyAuditChain([entry])).toBe(true)
  })

  it("verifies a multi-entry chain", () => {
    const e1 = createAuditEntry("req-1", "APPROVED", makeActor("alice"), null)
    const e2 = createAuditEntry("req-2", "REJECTED", makeActor("bob"), e1.entryHash)
    const e3 = createAuditEntry("req-3", "APPROVED", makeActor("charlie"), e2.entryHash)

    expect(verifyAuditChain([e1, e2, e3])).toBe(true)
  })

  it("detects tampered entry hash", () => {
    const e1 = createAuditEntry("req-1", "APPROVED", makeActor("alice"), null)
    const e2 = createAuditEntry("req-2", "REJECTED", makeActor("bob"), e1.entryHash)

    // Tamper with the first entry's hash
    const tampered: AuditEntry = { ...e1, entryHash: "0".repeat(64) }
    expect(verifyAuditChain([tampered, e2])).toBe(false)
  })

  it("detects broken chain link", () => {
    const e1 = createAuditEntry("req-1", "APPROVED", makeActor("alice"), null)
    const e2 = createAuditEntry("req-2", "REJECTED", makeActor("bob"), e1.entryHash)

    // Break the chain: e2 should reference e1's hash but doesn't
    const broken: AuditEntry = { ...e2, previousHash: "a".repeat(64) }
    expect(verifyAuditChain([e1, broken])).toBe(false)
  })

  it("detects tampered decision", () => {
    const e1 = createAuditEntry("req-1", "APPROVED", makeActor("alice"), null)

    // Change the decision but keep the old hash
    const tampered: AuditEntry = { ...e1, decision: "REJECTED" }
    expect(verifyAuditChain([tampered])).toBe(false)
  })

  it("detects tampered actor", () => {
    const e1 = createAuditEntry("req-1", "APPROVED", makeActor("alice"), null)

    // Change the actor but keep the old hash
    const tamperedActor = { ...e1.actor, userId: "mallory" }
    const tampered: AuditEntry = { ...e1, actor: tamperedActor }
    expect(verifyAuditChain([tampered])).toBe(false)
  })
})
