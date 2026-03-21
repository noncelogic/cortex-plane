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

import accessRequestsListFixture from "../../fixtures/api-responses/access-requests-list.json"
import actionResponsesFixture from "../../fixtures/api-responses/action-responses.json"
import agentChannelBindingsFixture from "../../fixtures/api-responses/agent-channel-bindings.json"
import agentCostFixture from "../../fixtures/api-responses/agent-cost.json"
import agentCredentialBindingsFixture from "../../fixtures/api-responses/agent-credential-bindings.json"
import agentDetailFixture from "../../fixtures/api-responses/agent-detail.json"
import agentEventsFixture from "../../fixtures/api-responses/agent-events.json"
import agentsListFixture from "../../fixtures/api-responses/agents-list.json"
import approvalsListFixture from "../../fixtures/api-responses/approvals-list.json"
import browserEventsFixture from "../../fixtures/api-responses/browser-events.json"
import browserObserveFixture from "../../fixtures/api-responses/browser-observe.json"
import bulkBindResponseFixture from "../../fixtures/api-responses/bulk-bind-response.json"
import capabilityAuditFixture from "../../fixtures/api-responses/capability-audit.json"
import channelBindingsWithAgentFixture from "../../fixtures/api-responses/channel-bindings-with-agent.json"
import channelsListFixture from "../../fixtures/api-responses/channels-list.json"
import chatResponseFixture from "../../fixtures/api-responses/chat-response.json"
import contentListFixture from "../../fixtures/api-responses/content-list.json"
import credentialsListFixture from "../../fixtures/api-responses/credentials-list.json"
import dashboardActivityFixture from "../../fixtures/api-responses/dashboard-activity.json"
import dashboardSummaryFixture from "../../fixtures/api-responses/dashboard-summary.json"
import effectiveToolsFixture from "../../fixtures/api-responses/effective-tools.json"
import grantsListFixture from "../../fixtures/api-responses/grants-list.json"
import jobDetailFixture from "../../fixtures/api-responses/job-detail.json"
import jobsListFixture from "../../fixtures/api-responses/jobs-list.json"
import mcpServerDetailFixture from "../../fixtures/api-responses/mcp-server-detail.json"
import mcpServersListFixture from "../../fixtures/api-responses/mcp-servers-list.json"
import memorySearchFixture from "../../fixtures/api-responses/memory-search.json"
import messagesListFixture from "../../fixtures/api-responses/messages-list.json"
import oauthInitFixture from "../../fixtures/api-responses/oauth-init.json"
import pairingCodesListFixture from "../../fixtures/api-responses/pairing-codes-list.json"
import providersListFixture from "../../fixtures/api-responses/providers-list.json"
import screenshotsListFixture from "../../fixtures/api-responses/screenshots-list.json"
import sessionDeleteFixture from "../../fixtures/api-responses/session-delete.json"
import sessionsListFixture from "../../fixtures/api-responses/sessions-list.json"
import toolBindingsListFixture from "../../fixtures/api-responses/tool-bindings-list.json"
import userDetailFixture from "../../fixtures/api-responses/user-detail.json"
import userUsageFixture from "../../fixtures/api-responses/user-usage.json"
import {
  ApprovalDecisionResponseSchema,
  ArchiveContentResponseSchema,
  CreateAgentJobResponseSchema,
  PauseResponseSchema,
  PublishContentResponseSchema,
  ResumeResponseSchema,
  RetryJobResponseSchema,
  SteerResponseSchema,
  SyncMemoryResponseSchema,
} from "../lib/schemas/actions"
import {
  AgentCredentialBindingListResponseSchema,
  AgentCredentialBindingSchema,
} from "../lib/schemas/agent-credentials"
import {
  AgentDetailSchema,
  AgentListResponseSchema,
  AgentSummarySchema,
} from "../lib/schemas/agents"
import { ApprovalListResponseSchema, ApprovalRequestSchema } from "../lib/schemas/approvals"
import {
  BrowserEventListResponseSchema,
  BrowserEventSchema,
  BrowserSessionSchema,
  CaptureScreenshotResponseSchema,
  ScreenshotListResponseSchema,
  ScreenshotSchema,
  TraceStartResponseSchema,
  TraceStateSchema,
  TraceStopResponseSchema,
} from "../lib/schemas/browser"
import { ChannelConfigListResponseSchema, ChannelConfigSchema } from "../lib/schemas/channel-config"
import {
  AgentChannelBindingListResponseSchema,
  AgentChannelBindingSchema,
  BindingWithAgentSchema,
  ChannelBindingsResponseSchema,
} from "../lib/schemas/channels"
import {
  ChatResponseSchema,
  MessageListResponseSchema,
  SessionDeleteResponseSchema,
  SessionListResponseSchema,
  SessionMessageSchema,
  SessionSchema,
} from "../lib/schemas/chat"
import { ContentListResponseSchema } from "../lib/schemas/content"
import {
  CredentialListResponseSchema,
  CredentialSchema,
  OAuthInitResultSchema,
  ProviderInfoSchema,
  ProviderListResponseSchema,
} from "../lib/schemas/credentials"
import {
  DashboardActivitySchema,
  DashboardSummarySchema,
  JobDetailSchema,
  JobListResponseSchema,
  JobSummarySchema,
} from "../lib/schemas/jobs"
import {
  McpServerDetailSchema,
  McpServerListResponseSchema,
  McpServerSchema,
  McpServerToolSchema,
} from "../lib/schemas/mcp-servers"
import { MemoryRecordSchema, MemorySearchResponseSchema } from "../lib/schemas/memory"
import {
  AgentCostResponseSchema,
  AgentEventListResponseSchema,
  AgentEventSchema,
  CostBreakdownEntrySchema,
  DryRunResponseSchema,
  KillResponseSchema,
  QuarantineResponseSchema,
  ReleaseResponseSchema,
  ReplayResponseSchema,
} from "../lib/schemas/operations"
import {
  BulkBindResponseSchema,
  BulkBindSummarySchema,
  CapabilityAuditEntrySchema,
  CapabilityAuditResponseSchema,
  EffectiveToolSchema,
  EffectiveToolsResponseSchema,
  ToolBindingListResponseSchema,
  ToolBindingSchema,
} from "../lib/schemas/tool-bindings"
import {
  AccessRequestListResponseSchema,
  AccessRequestSchema,
  GrantListResponseSchema,
  PairingCodeListResponseSchema,
  PairingCodeSchema,
  PendingCountResponseSchema,
  UserDetailResponseSchema,
  UserGrantSchema,
  UserUsageLedgerSchema,
  UserUsageResponseSchema,
} from "../lib/schemas/users"

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

  describe("GET /jobs/:jobId — JobDetailSchema", () => {
    it("parses the fixture successfully", () => {
      const result = JobDetailSchema.parse(jobDetailFixture)
      expect(result.id).toBe("c3d4e5f6-a7b8-9012-cdef-123456789012")
      expect(result.agentName).toBe("ResearchBot")
      expect(result.status).toBe("FAILED")
      expect(result.failureReason?.message).toBe("Timeout exceeded")
      expect(result.failureReason?.category).toBe("timeout")
      expect(result.durationMs).toBe(175000)
      expect(result.steps).toHaveLength(3)
      expect(result.logs).toHaveLength(3)
      expect(result.tokenUsage?.tokensIn).toBe(4200)
    })

    it("does not silently drop job detail fields", () => {
      const parsed = JobDetailSchema.parse(jobDetailFixture)
      const parsedKeys = collectKeys(parsed)
      const fixtureKeys = collectKeys(jobDetailFixture)

      for (const key of parsedKeys) {
        expect(fixtureKeys.has(key), `parsed key "${key}" not in fixture`).toBe(true)
      }

      for (const key of fixtureKeys) {
        expect(parsedKeys.has(key), `fixture key "${key}" was silently dropped`).toBe(true)
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
      expect(result.providers).toHaveLength(4)
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

  describe("GET /agents/:id/credentials — AgentCredentialBindingListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = AgentCredentialBindingListResponseSchema.parse(agentCredentialBindingsFixture)
      expect(result.bindings).toHaveLength(2)
      expect(result.bindings[0]?.credentialClass).toBe("llm_provider")
      expect(result.bindings[1]?.provider).toBe("github")
    })

    it("does not silently drop binding fields", () => {
      for (const binding of agentCredentialBindingsFixture.bindings) {
        assertContractMatch(AgentCredentialBindingSchema, binding, `Binding ${binding.id}`)
      }
    })

    it("AgentCredentialBindingSchema.strict() accepts fixture exactly", () => {
      const strict = AgentCredentialBindingSchema.strict()
      for (const binding of agentCredentialBindingsFixture.bindings) {
        expect(() => strict.parse(binding)).not.toThrow()
      }
    })

    it("parses binding with null displayLabel", () => {
      const result = AgentCredentialBindingSchema.parse(agentCredentialBindingsFixture.bindings[1])
      expect(result.displayLabel).toBeNull()
    })
  })

  describe("GET /channels — ChannelConfigListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ChannelConfigListResponseSchema.parse(channelsListFixture)
      expect(result.channels).toHaveLength(2)
      expect(result.channels[0]?.type).toBe("telegram")
      expect(result.channels[1]?.enabled).toBe(false)
    })

    it("does not silently drop channel config fields", () => {
      for (const channel of channelsListFixture.channels) {
        assertContractMatch(ChannelConfigSchema, channel, `Channel ${channel.id}`)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Chat & Session schemas
  // ---------------------------------------------------------------------------

  describe("GET /agents/:id/sessions — SessionListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = SessionListResponseSchema.parse(sessionsListFixture)
      expect(result.sessions).toHaveLength(2)
      expect(result.count).toBe(2)
    })

    it("does not silently drop session fields", () => {
      for (const session of sessionsListFixture.sessions) {
        assertContractMatch(SessionSchema, session, `Session ${session.id}`)
      }
    })
  })

  describe("GET /sessions/:id/messages — MessageListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = MessageListResponseSchema.parse(messagesListFixture)
      expect(result.messages).toHaveLength(2)
      expect(result.count).toBe(2)
    })

    it("does not silently drop message fields", () => {
      for (const msg of messagesListFixture.messages) {
        assertContractMatch(SessionMessageSchema, msg, `Message ${msg.id}`)
      }
    })
  })

  describe("POST /agents/:agentId/chat — ChatResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ChatResponseSchema.parse(chatResponseFixture)
      expect(result.job_id).toBe("job-chat-001")
      expect(result.session_id).toBe("sess-001")
      expect(result.status).toBe("RUNNING")
    })

    it("does not silently drop chat response fields", () => {
      assertContractMatch(ChatResponseSchema, chatResponseFixture, "ChatResponse")
    })
  })

  describe("DELETE /sessions/:id — SessionDeleteResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = SessionDeleteResponseSchema.parse(sessionDeleteFixture)
      expect(result.id).toBe("sess-001")
      expect(result.status).toBe("ended")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(SessionDeleteResponseSchema, sessionDeleteFixture, "SessionDelete")
    })
  })

  // ---------------------------------------------------------------------------
  // Operations schemas
  // ---------------------------------------------------------------------------

  describe("GET /agents/:agentId/events — AgentEventListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = AgentEventListResponseSchema.parse(agentEventsFixture)
      expect(result.events).toHaveLength(2)
      expect(result.total).toBe(2)
      expect(result.costSummary.totalUsd).toBe(0.0042)
    })

    it("does not silently drop event fields", () => {
      for (const event of agentEventsFixture.events) {
        assertContractMatch(AgentEventSchema, event, `Event ${event.id}`)
      }
    })
  })

  describe("GET /agents/:agentId/cost — AgentCostResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = AgentCostResponseSchema.parse(agentCostFixture)
      expect(result.summary.totalUsd).toBe(1.25)
      expect(result.breakdown).toHaveLength(2)
    })

    it("does not silently drop cost breakdown fields (passthrough)", () => {
      for (const entry of agentCostFixture.breakdown) {
        const parsed = CostBreakdownEntrySchema.parse(entry)
        const parsedKeys = collectKeys(parsed)
        const fixtureKeys = collectKeys(entry)
        // passthrough should preserve extra keys
        for (const key of fixtureKeys) {
          expect(
            parsedKeys.has(key),
            `fixture key "${key}" dropped by CostBreakdownEntrySchema`,
          ).toBe(true)
        }
      }
    })
  })

  describe("POST /agents/:agentId/kill — KillResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = KillResponseSchema.parse(actionResponsesFixture.kill)
      expect(result.agentId).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
      expect(result.state).toBe("TERMINATED")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(KillResponseSchema, actionResponsesFixture.kill, "KillResponse")
    })
  })

  describe("POST /agents/:agentId/dry-run — DryRunResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = DryRunResponseSchema.parse(actionResponsesFixture.dryRun)
      expect(result.plannedActions).toHaveLength(1)
      expect(result.estimatedCostUsd).toBe(0.002)
    })

    it("does not silently drop fields", () => {
      assertContractMatch(DryRunResponseSchema, actionResponsesFixture.dryRun, "DryRunResponse")
    })
  })

  describe("POST /agents/:agentId/replay — ReplayResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ReplayResponseSchema.parse(actionResponsesFixture.replay)
      expect(result.replayJobId).toBe("job-replay-001")
      expect(result.fromCheckpoint).toBe("ckpt-001")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(ReplayResponseSchema, actionResponsesFixture.replay, "ReplayResponse")
    })
  })

  describe("POST /agents/:agentId/quarantine — QuarantineResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = QuarantineResponseSchema.parse(actionResponsesFixture.quarantine)
      expect(result.state).toBe("QUARANTINED")
      expect(result.reason).toBe("Exceeded cost budget")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(
        QuarantineResponseSchema,
        actionResponsesFixture.quarantine,
        "QuarantineResponse",
      )
    })
  })

  describe("POST /agents/:agentId/release — ReleaseResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ReleaseResponseSchema.parse(actionResponsesFixture.release)
      expect(result.state).toBe("READY")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(ReleaseResponseSchema, actionResponsesFixture.release, "ReleaseResponse")
    })
  })

  // ---------------------------------------------------------------------------
  // Action response schemas
  // ---------------------------------------------------------------------------

  describe("POST /agents/:agentId/steer — SteerResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = SteerResponseSchema.parse(actionResponsesFixture.steer)
      expect(result.acknowledged).toBe(true)
      expect(result.incorporatedAtTurn).toBe(7)
    })

    it("does not silently drop fields", () => {
      assertContractMatch(SteerResponseSchema, actionResponsesFixture.steer, "SteerResponse")
    })
  })

  describe("POST /agents/:agentId/pause — PauseResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = PauseResponseSchema.parse(actionResponsesFixture.pause)
      expect(result.status).toBe("pausing")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(PauseResponseSchema, actionResponsesFixture.pause, "PauseResponse")
    })
  })

  describe("POST /agents/:agentId/resume — ResumeResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ResumeResponseSchema.parse(actionResponsesFixture.resume)
      expect(result.status).toBe("resuming")
      expect(result.from_checkpoint).toBe("ckpt-001")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(ResumeResponseSchema, actionResponsesFixture.resume, "ResumeResponse")
    })
  })

  describe("POST /agents/:agentId/jobs — CreateAgentJobResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = CreateAgentJobResponseSchema.parse(actionResponsesFixture.createJob)
      expect(result.status).toBe("SCHEDULED")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(
        CreateAgentJobResponseSchema,
        actionResponsesFixture.createJob,
        "CreateAgentJobResponse",
      )
    })
  })

  describe("POST /approval/requests/:id/decide — ApprovalDecisionResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ApprovalDecisionResponseSchema.parse(actionResponsesFixture.approvalDecision)
      expect(result.decision).toBe("APPROVED")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(
        ApprovalDecisionResponseSchema,
        actionResponsesFixture.approvalDecision,
        "ApprovalDecisionResponse",
      )
    })
  })

  describe("POST /jobs/:jobId/retry — RetryJobResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = RetryJobResponseSchema.parse(actionResponsesFixture.retryJob)
      expect(result.status).toBe("retrying")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(
        RetryJobResponseSchema,
        actionResponsesFixture.retryJob,
        "RetryJobResponse",
      )
    })
  })

  describe("POST /memory/sync — SyncMemoryResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = SyncMemoryResponseSchema.parse(actionResponsesFixture.syncMemory)
      expect(result.stats.upserted).toBe(12)
    })

    it("does not silently drop fields", () => {
      assertContractMatch(
        SyncMemoryResponseSchema,
        actionResponsesFixture.syncMemory,
        "SyncMemoryResponse",
      )
    })
  })

  describe("POST /content/:id/publish — PublishContentResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = PublishContentResponseSchema.parse(actionResponsesFixture.publishContent)
      expect(result.status).toBe("published")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(
        PublishContentResponseSchema,
        actionResponsesFixture.publishContent,
        "PublishContentResponse",
      )
    })
  })

  describe("POST /content/:id/archive — ArchiveContentResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ArchiveContentResponseSchema.parse(actionResponsesFixture.archiveContent)
      expect(result.status).toBe("archived")
    })

    it("does not silently drop fields", () => {
      assertContractMatch(
        ArchiveContentResponseSchema,
        actionResponsesFixture.archiveContent,
        "ArchiveContentResponse",
      )
    })
  })

  // ---------------------------------------------------------------------------
  // Channel binding schemas
  // ---------------------------------------------------------------------------

  describe("GET /agents/:agentId/channels — AgentChannelBindingListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = AgentChannelBindingListResponseSchema.parse(agentChannelBindingsFixture)
      expect(result.bindings).toHaveLength(2)
    })

    it("does not silently drop binding fields", () => {
      for (const binding of agentChannelBindingsFixture.bindings) {
        assertContractMatch(AgentChannelBindingSchema, binding, `ChannelBinding ${binding.id}`)
      }
    })
  })

  describe("GET /channels/:id/bindings — ChannelBindingsResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ChannelBindingsResponseSchema.parse(channelBindingsWithAgentFixture)
      expect(result.bindings).toHaveLength(1)
      expect(result.bindings[0]?.agent_name).toBe("Research Agent")
    })

    it("does not silently drop binding-with-agent fields", () => {
      for (const binding of channelBindingsWithAgentFixture.bindings) {
        assertContractMatch(BindingWithAgentSchema, binding, `BindingWithAgent ${binding.id}`)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Tool binding schemas
  // ---------------------------------------------------------------------------

  describe("GET /agents/:agentId/tool-bindings — ToolBindingListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ToolBindingListResponseSchema.parse(toolBindingsListFixture)
      expect(result.bindings).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it("does not silently drop tool binding fields", () => {
      for (const binding of toolBindingsListFixture.bindings) {
        assertContractMatch(ToolBindingSchema, binding, `ToolBinding ${binding.id}`)
      }
    })
  })

  describe("POST /agents/:agentId/tool-bindings/bulk — BulkBindResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = BulkBindResponseSchema.parse(bulkBindResponseFixture)
      expect(result.created).toBe(2)
      expect(result.bindings).toHaveLength(2)
    })

    it("does not silently drop bulk bind fields", () => {
      for (const binding of bulkBindResponseFixture.bindings) {
        assertContractMatch(BulkBindSummarySchema, binding, `BulkBind ${binding.id}`)
      }
    })
  })

  describe("GET /agents/:agentId/effective-tools — EffectiveToolsResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = EffectiveToolsResponseSchema.parse(effectiveToolsFixture)
      expect(result.tools).toHaveLength(1)
      expect(result.assembledAt).toBeDefined()
    })

    it("does not silently drop effective tool fields", () => {
      for (const tool of effectiveToolsFixture.tools) {
        assertContractMatch(EffectiveToolSchema, tool, `EffectiveTool ${tool.toolRef}`)
      }
    })
  })

  describe("GET /agents/:agentId/capability-audit — CapabilityAuditResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = CapabilityAuditResponseSchema.parse(capabilityAuditFixture)
      expect(result.entries).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it("does not silently drop audit entry fields", () => {
      for (const entry of capabilityAuditFixture.entries) {
        assertContractMatch(CapabilityAuditEntrySchema, entry, `AuditEntry ${entry.id}`)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // User schemas
  // ---------------------------------------------------------------------------

  describe("GET /users/:id — UserDetailResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = UserDetailResponseSchema.parse(userDetailFixture)
      expect(result.user.display_name).toBe("Alice Johnson")
      expect(result.channelMappings).toHaveLength(2)
      expect(result.grants).toHaveLength(2)
    })

    it("does not silently drop user detail fields", () => {
      assertContractMatch(UserDetailResponseSchema, userDetailFixture, "UserDetailResponse")
    })
  })

  describe("GET /agents/:agentId/users — GrantListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = GrantListResponseSchema.parse(grantsListFixture)
      expect(result.grants).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it("does not silently drop grant fields", () => {
      for (const grant of grantsListFixture.grants) {
        assertContractMatch(UserGrantSchema, grant, `Grant ${grant.id}`)
      }
    })
  })

  describe("GET /agents/:agentId/access-requests — AccessRequestListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = AccessRequestListResponseSchema.parse(accessRequestsListFixture)
      expect(result.requests).toHaveLength(1)
      expect(result.total).toBe(1)
    })

    it("does not silently drop access request fields", () => {
      for (const req of accessRequestsListFixture.requests) {
        assertContractMatch(AccessRequestSchema, req, `AccessRequest ${req.id}`)
      }
    })
  })

  describe("GET /agents/:agentId/pairing-codes — PairingCodeListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = PairingCodeListResponseSchema.parse(pairingCodesListFixture)
      expect(result.codes).toHaveLength(1)
    })

    it("does not silently drop pairing code fields", () => {
      for (const code of pairingCodesListFixture.codes) {
        assertContractMatch(PairingCodeSchema, code, `PairingCode ${code.id}`)
      }
    })
  })

  describe("GET /access-requests/pending-count — PendingCountResponseSchema", () => {
    it("parses inline fixture", () => {
      const fixture = { counts: { "agent-1": 3, "agent-2": 0 } }
      const result = PendingCountResponseSchema.parse(fixture)
      expect(result.counts["agent-1"]).toBe(3)
    })
  })

  describe("GET /users/:id/usage — UserUsageResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = UserUsageResponseSchema.parse(userUsageFixture)
      expect(result.usage).toHaveLength(1)
    })

    it("does not silently drop usage ledger fields", () => {
      for (const entry of userUsageFixture.usage) {
        assertContractMatch(UserUsageLedgerSchema, entry, `UsageLedger ${entry.id}`)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // MCP Server schemas
  // ---------------------------------------------------------------------------

  describe("GET /mcp-servers — McpServerListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = McpServerListResponseSchema.parse(mcpServersListFixture)
      expect(result.servers).toHaveLength(1)
      expect(result.pagination).toBeDefined()
    })

    it("does not silently drop server fields", () => {
      for (const server of mcpServersListFixture.servers) {
        assertContractMatch(McpServerSchema, server, `McpServer ${server.id}`)
      }
    })
  })

  describe("GET /mcp-servers/:id — McpServerDetailSchema", () => {
    it("parses the fixture successfully", () => {
      const result = McpServerDetailSchema.parse(mcpServerDetailFixture)
      expect(result.id).toBe("mcp-001")
      expect(result.tools).toHaveLength(1)
    })

    it("does not silently drop server detail fields", () => {
      const parsed = McpServerDetailSchema.parse(mcpServerDetailFixture)
      const parsedKeys = collectKeys(parsed)
      const fixtureKeys = collectKeys(mcpServerDetailFixture)

      for (const key of parsedKeys) {
        expect(fixtureKeys.has(key), `parsed key "${key}" not in fixture`).toBe(true)
      }
      for (const key of fixtureKeys) {
        expect(parsedKeys.has(key), `fixture key "${key}" was silently dropped`).toBe(true)
      }
    })

    it("does not silently drop tool fields", () => {
      for (const tool of mcpServerDetailFixture.tools) {
        assertContractMatch(McpServerToolSchema, tool, `McpServerTool ${tool.id}`)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Browser schemas (events, screenshots, traces)
  // ---------------------------------------------------------------------------

  describe("GET /agents/:agentId/browser/events — BrowserEventListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = BrowserEventListResponseSchema.parse(browserEventsFixture)
      expect(result.events).toHaveLength(2)
    })

    it("does not silently drop event fields", () => {
      for (const event of browserEventsFixture.events) {
        assertContractMatch(BrowserEventSchema, event, `BrowserEvent ${event.id}`)
      }
    })
  })

  describe("GET /agents/:agentId/browser/screenshots — ScreenshotListResponseSchema", () => {
    it("parses the fixture successfully", () => {
      const result = ScreenshotListResponseSchema.parse(screenshotsListFixture)
      expect(result.screenshots).toHaveLength(1)
    })

    it("does not silently drop screenshot fields", () => {
      for (const ss of screenshotsListFixture.screenshots) {
        assertContractMatch(ScreenshotSchema, ss, `Screenshot ${ss.id}`)
      }
    })
  })

  describe("POST /agents/:agentId/observe/screenshot — CaptureScreenshotResponseSchema", () => {
    it("parses inline fixture", () => {
      const fixture = {
        timestamp: "2025-11-01T10:00:00.000Z",
        url: "https://example.com",
        title: "Example",
        filePath: "/tmp/screenshot.png",
      }
      const result = CaptureScreenshotResponseSchema.parse(fixture)
      expect(result.timestamp).toBeDefined()
      assertContractMatch(CaptureScreenshotResponseSchema, fixture, "CaptureScreenshot")
    })
  })

  describe("GET /agents/:agentId/observe/trace — TraceStateSchema", () => {
    it("parses idle state", () => {
      const fixture = { status: "idle" }
      const result = TraceStateSchema.parse(fixture)
      expect(result.status).toBe("idle")
    })

    it("parses recording state with options", () => {
      const fixture = {
        status: "recording",
        startedAt: "2025-11-01T10:00:00.000Z",
        options: { snapshots: true, screenshots: true, network: false, console: true },
      }
      const result = TraceStateSchema.parse(fixture)
      expect(result.status).toBe("recording")
      assertContractMatch(TraceStateSchema, fixture, "TraceState")
    })
  })

  describe("POST /agents/:agentId/observe/trace/start — TraceStartResponseSchema", () => {
    it("parses inline fixture", () => {
      const fixture = { status: "recording", startedAt: "2025-11-01T10:00:00.000Z" }
      const result = TraceStartResponseSchema.parse(fixture)
      expect(result.status).toBe("recording")
      assertContractMatch(TraceStartResponseSchema, fixture, "TraceStartResponse")
    })
  })

  describe("POST /agents/:agentId/observe/trace/stop — TraceStopResponseSchema", () => {
    it("parses inline fixture", () => {
      const fixture = { status: "stopped", filePath: "/tmp/trace.zip", durationMs: 5000 }
      const result = TraceStopResponseSchema.parse(fixture)
      expect(result.durationMs).toBe(5000)
      assertContractMatch(TraceStopResponseSchema, fixture, "TraceStopResponse")
    })
  })

  // ---------------------------------------------------------------------------
  // Dashboard schemas
  // ---------------------------------------------------------------------------

  describe("GET /dashboard/summary — DashboardSummarySchema", () => {
    it("parses the fixture successfully", () => {
      const result = DashboardSummarySchema.parse(dashboardSummaryFixture)
      expect(result.totalAgents).toBe(5)
      expect(result.activeJobs).toBe(2)
      expect(result.pendingApprovals).toBe(1)
      expect(result.memoryRecords).toBe(150)
    })

    it("does not silently drop fields", () => {
      assertContractMatch(DashboardSummarySchema, dashboardSummaryFixture, "DashboardSummary")
    })
  })

  describe("GET /dashboard/activity — DashboardActivitySchema", () => {
    it("parses the fixture successfully", () => {
      const result = DashboardActivitySchema.parse(dashboardActivityFixture)
      expect(result.activity).toHaveLength(1)
      expect(result.activity[0]?.status).toBe("COMPLETED")
    })

    it("does not silently drop activity fields", () => {
      for (const job of dashboardActivityFixture.activity) {
        assertContractMatch(JobSummarySchema, job, `ActivityJob ${job.id}`)
      }
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

    it("ChannelConfigSchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(ChannelConfigSchema)
      for (const channel of channelsListFixture.channels) {
        expect(() => strict.parse(channel)).not.toThrow()
      }
    })

    it("SessionSchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(SessionSchema)
      for (const session of sessionsListFixture.sessions) {
        expect(() => strict.parse(session)).not.toThrow()
      }
    })

    it("AgentEventSchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(AgentEventSchema)
      for (const event of agentEventsFixture.events) {
        expect(() => strict.parse(event)).not.toThrow()
      }
    })

    it("ToolBindingSchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(ToolBindingSchema)
      for (const binding of toolBindingsListFixture.bindings) {
        expect(() => strict.parse(binding)).not.toThrow()
      }
    })

    it("AgentChannelBindingSchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(AgentChannelBindingSchema)
      for (const binding of agentChannelBindingsFixture.bindings) {
        expect(() => strict.parse(binding)).not.toThrow()
      }
    })

    it("DashboardSummarySchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(DashboardSummarySchema)
      expect(() => strict.parse(dashboardSummaryFixture)).not.toThrow()
    })

    it("McpServerSchema.strict() accepts fixture exactly", () => {
      const strict = makeStrict(McpServerSchema)
      for (const server of mcpServersListFixture.servers) {
        expect(() => strict.parse(server)).not.toThrow()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Dashboard stat cards — zero-result responses
  // ---------------------------------------------------------------------------

  describe("dashboard stat cards: zero-result API responses", () => {
    it("JobListResponseSchema parses empty jobs with pagination.total = 0", () => {
      const emptyResponse = {
        jobs: [],
        pagination: { total: 0, limit: 5, offset: 0, hasMore: false },
      }
      const result = JobListResponseSchema.parse(emptyResponse)
      expect(result.jobs).toHaveLength(0)
      expect(result.pagination.total).toBe(0)
    })

    it("ApprovalListResponseSchema parses empty approvals with pagination.total = 0", () => {
      const emptyResponse = {
        approvals: [],
        pagination: { total: 0, limit: 1, offset: 0, hasMore: false },
      }
      const result = ApprovalListResponseSchema.parse(emptyResponse)
      expect(result.approvals).toHaveLength(0)
      expect(result.pagination?.total).toBe(0)
    })

    it("AgentListResponseSchema parses empty agents with pagination.total = 0", () => {
      const emptyResponse = {
        agents: [],
        pagination: { total: 0, limit: 100, offset: 0, hasMore: false },
      }
      const result = AgentListResponseSchema.parse(emptyResponse)
      expect(result.agents).toHaveLength(0)
      expect(result.pagination.total).toBe(0)
    })

    it("AgentListResponseSchema normalizes count-only response to pagination", () => {
      const countOnlyResponse = { agents: [], count: 0 }
      const result = AgentListResponseSchema.parse(countOnlyResponse)
      expect(result.pagination.total).toBe(0)
    })

    it("SessionListResponseSchema parses empty sessions", () => {
      const emptyResponse = { sessions: [], count: 0 }
      const result = SessionListResponseSchema.parse(emptyResponse)
      expect(result.sessions).toHaveLength(0)
      expect(result.count).toBe(0)
    })

    it("AgentEventListResponseSchema parses empty events", () => {
      const emptyResponse = {
        events: [],
        total: 0,
        costSummary: { totalUsd: 0, tokensIn: 0, tokensOut: 0 },
      }
      const result = AgentEventListResponseSchema.parse(emptyResponse)
      expect(result.events).toHaveLength(0)
      expect(result.total).toBe(0)
    })

    it("ToolBindingListResponseSchema parses empty bindings", () => {
      const emptyResponse = { bindings: [], total: 0 }
      const result = ToolBindingListResponseSchema.parse(emptyResponse)
      expect(result.bindings).toHaveLength(0)
      expect(result.total).toBe(0)
    })

    it("McpServerListResponseSchema normalizes count-only response", () => {
      const countOnlyResponse = { servers: [], count: 0 }
      const result = McpServerListResponseSchema.parse(countOnlyResponse)
      expect(result.pagination.total).toBe(0)
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

    it("adding a field to control-plane without updating dashboard schema fails CI", () => {
      // Simulates a control-plane adding `newField` to the agent response
      // without updating the dashboard schema — the strict parse detects it.
      const strict = makeStrict(AgentEventSchema)
      const event = { ...agentEventsFixture.events[0]!, newBackendField: "unexpected" }
      const result = strict.safeParse(event)
      expect(result.success).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Generate-pairing-code response (inline — small schema)
  // ---------------------------------------------------------------------------

  describe("POST /agents/:agentId/pairing-codes — GeneratePairingCodeResponseSchema", () => {
    it("parses inline fixture", () => {
      const fixture = { code: "ABCD-1234", expiresAt: "2025-12-01T00:00:00.000Z" }
      const result = z.object({ code: z.string(), expiresAt: z.string() }).parse(fixture)
      expect(result.code).toBe("ABCD-1234")
    })
  })
})
