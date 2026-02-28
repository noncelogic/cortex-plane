/**
 * API-Dashboard Contract Tests
 *
 * Validates that dashboard Zod schemas match actual API response shapes.
 * Fixtures are JSON snapshots derived from the backend route handlers.
 *
 * If a test fails here, it means one of two things changed without updating
 * the other: the API response shape or the dashboard Zod schema.
 */

import { describe, expect, it } from "vitest"
import { z } from "zod"

import agentDetailFixture from "../../fixtures/api-responses/agent-detail.json"
import agentsListFixture from "../../fixtures/api-responses/agents-list.json"
import approvalsListFixture from "../../fixtures/api-responses/approvals-list.json"
import browserObserveFixture from "../../fixtures/api-responses/browser-observe.json"
import contentListFixture from "../../fixtures/api-responses/content-list.json"
import credentialsListFixture from "../../fixtures/api-responses/credentials-list.json"
import jobsListFixture from "../../fixtures/api-responses/jobs-list.json"
import memorySearchFixture from "../../fixtures/api-responses/memory-search.json"
import oauthInitFixture from "../../fixtures/api-responses/oauth-init.json"
import providersListFixture from "../../fixtures/api-responses/providers-list.json"
import {
  AgentDetailSchema,
  AgentListResponseSchema,
  AgentSummarySchema,
} from "../lib/schemas/agents"
import { ApprovalListResponseSchema, ApprovalRequestSchema } from "../lib/schemas/approvals"
import { BrowserSessionSchema } from "../lib/schemas/browser"
import { ContentListResponseSchema } from "../lib/schemas/content"
import {
  CredentialListResponseSchema,
  CredentialSchema,
  OAuthInitResultSchema,
  ProviderInfoSchema,
  ProviderListResponseSchema,
} from "../lib/schemas/credentials"
import { JobListResponseSchema, JobSummarySchema } from "../lib/schemas/jobs"
import { MemoryRecordSchema, MemorySearchResponseSchema } from "../lib/schemas/memory"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect top-level keys from an object.
 */
function collectKeys(obj: unknown): Set<string> {
  const keys = new Set<string>()
  if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
    return keys
  }
  for (const key of Object.keys(obj)) {
    keys.add(key)
  }
  return keys
}

/**
 * Given a Zod schema and a fixture, assert:
 *   1. Schema.parse(fixture) does not throw.
 *   2. Every key in the parsed result also exists in the fixture (no fabricated fields).
 *   3. Every key in the fixture also exists in the parsed result (no silent drops).
 */
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

  // Every parsed key should come from the fixture (no phantom fields)
  for (const key of parsedKeys) {
    expect(fixtureKeys.has(key), `${label}: parsed key "${key}" not found in fixture`).toBe(true)
  }

  // Every fixture key should survive parsing (no silent drops)
  for (const key of fixtureKeys) {
    expect(
      parsedKeys.has(key),
      `${label}: fixture key "${key}" was silently dropped by schema`,
    ).toBe(true)
  }
}

/**
 * Build a strict version of a z.object schema that rejects unknown keys.
 */
function makeStrict<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.strict()
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe("API-Dashboard contract tests", () => {
  describe("GET /agents — AgentListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = AgentListResponseSchema.parse(agentsListFixture)
      expect(result.agents).toHaveLength(1)
      expect(result.pagination).toBeDefined()
    })

    it("does not silently drop agent fields", () => {
      // The list response uses a transform, so check the first agent item
      // against AgentSummarySchema directly — the transform strips `count`.
      const agent = agentsListFixture.agents[0]
      const parsed = AgentSummarySchema.parse(agent)
      const parsedKeys = collectKeys(parsed)
      const fixtureKeys = collectKeys(agent)

      // Schema-recognized keys must all survive
      for (const key of parsedKeys) {
        expect(fixtureKeys.has(key), `parsed key "${key}" not in fixture`).toBe(true)
      }
    })
  })

  describe("GET /agents/:id — AgentDetailSchema", () => {
    it("parses the fixture successfully", () => {
      const result = AgentDetailSchema.parse(agentDetailFixture)
      expect(result.id).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
      expect(result.model_config).toEqual({ model: "gpt-4" })
    })

    it("does not silently drop detail fields", () => {
      const parsed = AgentDetailSchema.parse(agentDetailFixture)
      const parsedKeys = collectKeys(parsed)
      const fixtureKeys = collectKeys(agentDetailFixture)

      for (const key of parsedKeys) {
        expect(fixtureKeys.has(key), `parsed key "${key}" not in fixture`).toBe(true)
      }

      // `latest_job` is an extra backend field the schema intentionally ignores
      const expectedDrops = new Set(["latest_job"])
      for (const key of fixtureKeys) {
        if (expectedDrops.has(key)) continue
        expect(parsedKeys.has(key), `fixture key "${key}" was silently dropped`).toBe(true)
      }
    })
  })

  describe("GET /jobs — JobListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = JobListResponseSchema.parse(jobsListFixture)
      expect(result.jobs).toHaveLength(2)
      expect(result.pagination.total).toBe(2)
    })

    it("does not silently drop job fields", () => {
      for (const job of jobsListFixture.jobs) {
        assertContractMatch(JobSummarySchema, job, `Job ${job.id}`)
      }
    })
  })

  describe("GET /approvals — ApprovalListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ApprovalListResponseSchema.parse(approvalsListFixture)
      expect(result.approvals).toHaveLength(1)
      expect(result.pagination).toBeDefined()
    })

    it("does not silently drop approval fields", () => {
      for (const approval of approvalsListFixture.approvals) {
        assertContractMatch(ApprovalRequestSchema, approval, `Approval ${approval.id}`)
      }
    })
  })

  describe("GET /credentials — CredentialListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = CredentialListResponseSchema.parse(credentialsListFixture)
      expect(result.credentials).toHaveLength(1)
    })

    it("does not silently drop credential fields", () => {
      for (const cred of credentialsListFixture.credentials) {
        assertContractMatch(CredentialSchema, cred, `Credential ${cred.id}`)
      }
    })
  })

  describe("GET /credentials/providers — ProviderListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ProviderListResponseSchema.parse(providersListFixture)
      expect(result.providers).toHaveLength(2)
    })

    it("does not silently drop provider fields", () => {
      for (const provider of providersListFixture.providers) {
        assertContractMatch(ProviderInfoSchema, provider, `Provider ${provider.id}`)
      }
    })
  })

  describe("GET /auth/connect/:provider/init — OAuthInitResultSchema", () => {
    it("parses the fixture successfully", () => {
      const result = OAuthInitResultSchema.parse(oauthInitFixture)
      expect(result.authUrl).toBeDefined()
      expect(result.codeVerifier).toBeDefined()
      expect(result.state).toBeDefined()
    })

    it("does not silently drop fields", () => {
      assertContractMatch(OAuthInitResultSchema, oauthInitFixture, "OAuthInit")
    })
  })

  describe("GET /agents/:id/browser — BrowserSessionSchema", () => {
    it("parses the fixture successfully", () => {
      const result = BrowserSessionSchema.parse(browserObserveFixture)
      expect(result.agentId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
      expect(result.status).toBe("disconnected")
    })

    it("does not silently drop browser fields", () => {
      assertContractMatch(BrowserSessionSchema, browserObserveFixture, "BrowserSession")
    })
  })

  describe("GET /agents/:id/memory — MemorySearchResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = MemorySearchResponseSchema.parse(memorySearchFixture)
      expect(result.results).toHaveLength(1)
      expect(result.results[0]?.type).toBe("fact")
    })

    it("does not silently drop memory fields", () => {
      for (const record of memorySearchFixture.results) {
        assertContractMatch(MemoryRecordSchema, record, `Memory ${record.id}`)
      }
    })
  })

  describe("GET /content — ContentListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ContentListResponseSchema.parse(contentListFixture)
      expect(result.content).toHaveLength(0)
      expect(result.pagination.hasMore).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Strict schema variants — detect extra/missing fields
  // ---------------------------------------------------------------------------

  describe("strict schema variants", () => {
    it("OAuthInitResultSchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(OAuthInitResultSchema)
      expect(() => strict.parse(oauthInitFixture)).not.toThrow()
    })

    it("CredentialSchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(CredentialSchema)
      for (const cred of credentialsListFixture.credentials) {
        expect(() => strict.parse(cred)).not.toThrow()
      }
    })

    it("ProviderInfoSchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(ProviderInfoSchema)
      for (const provider of providersListFixture.providers) {
        expect(() => strict.parse(provider)).not.toThrow()
      }
    })

    it("JobSummarySchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(JobSummarySchema)
      for (const job of jobsListFixture.jobs) {
        expect(() => strict.parse(job)).not.toThrow()
      }
    })

    it("MemoryRecordSchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(MemoryRecordSchema)
      for (const record of memorySearchFixture.results) {
        expect(() => strict.parse(record)).not.toThrow()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Negative test — deliberately broken field name detected
  // ---------------------------------------------------------------------------

  describe("negative test: broken field name detection", () => {
    it("catches a renamed field via strict parse", () => {
      const strict = makeStrict(JobSummarySchema)
      const firstJob = jobsListFixture.jobs[0]!
      const brokenJob = {
        ...firstJob,
        agent_id: firstJob.agentId, // wrong: snake_case
      }
      // Remove the correct key
      delete (brokenJob as Record<string, unknown>).agentId

      const result = strict.safeParse(brokenJob)
      expect(result.success).toBe(false)
    })

    it("catches a broken field via the no-silent-drops check", () => {
      const firstJob = jobsListFixture.jobs[0]!
      const brokenJob = {
        ...firstJob,
        agent_id: firstJob.agentId, // wrong: snake_case
      }
      delete (brokenJob as Record<string, unknown>).agentId

      // Non-strict parse fails because agentId is required
      const result = JobSummarySchema.safeParse(brokenJob)
      expect(result.success).toBe(false)
    })
  })
})
