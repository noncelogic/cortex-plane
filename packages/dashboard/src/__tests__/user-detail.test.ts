/**
 * User detail — schema contract tests + fixture validation.
 *
 * Validates that the user Zod schemas match the fixture shape and that
 * API client functions reference the correct schemas.
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"

import userDetailFixture from "../../fixtures/api-responses/user-detail.json"
import {
  ChannelMappingSchema,
  UserAccountSchema,
  UserDetailResponseSchema,
  UserGrantSchema,
  UserUsageResponseSchema,
} from "../lib/schemas/users"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectKeys(obj: unknown): Set<string> {
  if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
    return new Set()
  }
  return new Set(Object.keys(obj))
}

function assertContractMatch(schema: z.ZodTypeAny, fixture: unknown, label: string) {
  const result = schema.safeParse(fixture)
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`${label}: Schema.parse(fixture) failed:\n${formatted}`)
  }

  const parsed = result.data as Record<string, unknown>
  const fixtureObj = fixture as Record<string, unknown>

  const parsedKeys = collectKeys(parsed)
  const fixtureKeys = collectKeys(fixtureObj)

  for (const key of parsedKeys) {
    expect(fixtureKeys.has(key), `${label}: parsed key "${key}" not found in fixture`).toBe(true)
  }
  for (const key of fixtureKeys) {
    expect(parsedKeys.has(key), `${label}: fixture key "${key}" was silently dropped`).toBe(true)
  }
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe("User detail contract tests", () => {
  describe("GET /users/:id — UserDetailResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = UserDetailResponseSchema.parse(userDetailFixture)
      expect(result.user.id).toBe("u1a2b3c4-d5e6-7890-abcd-ef1234567890")
      expect(result.channelMappings).toHaveLength(2)
      expect(result.grants).toHaveLength(2)
    })

    it("does not silently drop user fields", () => {
      assertContractMatch(UserAccountSchema, userDetailFixture.user, "UserAccount")
    })

    it("does not silently drop channel mapping fields", () => {
      for (const mapping of userDetailFixture.channelMappings) {
        assertContractMatch(ChannelMappingSchema, mapping, `ChannelMapping ${mapping.id}`)
      }
    })

    it("does not silently drop grant fields", () => {
      for (const grant of userDetailFixture.grants) {
        assertContractMatch(UserGrantSchema, grant, `UserGrant ${grant.id}`)
      }
    })
  })

  describe("strict schema variants", () => {
    it("UserAccountSchema.strict() accepts fixture exactly", () => {
      const strict = UserAccountSchema.strict()
      expect(() => strict.parse(userDetailFixture.user)).not.toThrow()
    })

    it("ChannelMappingSchema.strict() accepts fixture exactly", () => {
      const strict = ChannelMappingSchema.strict()
      for (const mapping of userDetailFixture.channelMappings) {
        expect(() => strict.parse(mapping)).not.toThrow()
      }
    })

    it("UserGrantSchema.strict() accepts fixture exactly", () => {
      const strict = UserGrantSchema.strict()
      for (const grant of userDetailFixture.grants) {
        expect(() => strict.parse(grant)).not.toThrow()
      }
    })
  })

  describe("UserUsageResponseSchema", () => {
    it("parses empty usage array", () => {
      const empty = { usage: [] }
      const result = UserUsageResponseSchema.parse(empty)
      expect(result.usage).toHaveLength(0)
    })

    it("parses a usage entry", () => {
      const response = {
        usage: [
          {
            id: "ul-001",
            user_account_id: "u1",
            agent_id: "a1",
            period_start: "2025-12-01T00:00:00.000Z",
            period_end: "2025-12-02T00:00:00.000Z",
            messages_sent: 42,
            tokens_in: 12000,
            tokens_out: 8000,
            cost_usd: "0.15",
            created_at: "2025-12-02T00:00:01.000Z",
          },
        ],
      }
      const result = UserUsageResponseSchema.parse(response)
      expect(result.usage).toHaveLength(1)
      expect(result.usage[0]!.messages_sent).toBe(42)
      expect(result.usage[0]!.cost_usd).toBe("0.15")
    })
  })

  describe("edge cases", () => {
    it("handles user with null optional fields", () => {
      const minimalUser = {
        id: "u-min",
        display_name: null,
        email: null,
        avatar_url: null,
        role: "operator",
        oauth_provider: null,
        oauth_provider_id: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      }
      const result = UserAccountSchema.parse(minimalUser)
      expect(result.display_name).toBeNull()
      expect(result.email).toBeNull()
    })

    it("validates grant access_level enum", () => {
      const badGrant = { ...userDetailFixture.grants[0], access_level: "admin" }
      const result = UserGrantSchema.safeParse(badGrant)
      expect(result.success).toBe(false)
    })

    it("validates grant origin enum", () => {
      const badGrant = { ...userDetailFixture.grants[0], origin: "unknown" }
      const result = UserGrantSchema.safeParse(badGrant)
      expect(result.success).toBe(false)
    })

    it("validates user role enum", () => {
      const badUser = { ...userDetailFixture.user, role: "superuser" }
      const result = UserAccountSchema.safeParse(badUser)
      expect(result.success).toBe(false)
    })
  })
})
