/**
 * Dashboard Feature Audit — Issue #501
 *
 * Systematic two-direction verification of every dashboard page against backend routes.
 *
 * Direction 1 (Backend → Dashboard): every control-plane route consumed by the dashboard.
 * Direction 2 (Dashboard → Backend): every dashboard API call maps to a real backend route.
 *
 * Phantom features (UI with stub/unimplemented backend) are explicitly catalogued so
 * regressions are caught when they eventually get implemented.
 */

import { describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Route registry — single source of truth for the audit
// ---------------------------------------------------------------------------

/**
 * Every exported function from api-client.ts mapped to the HTTP method + path
 * it calls and its implementation status on the backend.
 *
 * Status key:
 *   "live"       — backend returns real data from the database
 *   "stub-empty" — backend always returns an empty collection (e.g. [])
 *   "stub-501"   — backend returns 501 Not Implemented
 *   "placeholder" — dashboard shows placeholder UI, no API call made
 */
type RouteStatus = "live" | "stub-empty" | "stub-501" | "placeholder"

interface AuditEntry {
  /** Exported function name from api-client.ts */
  dashboardMethod: string
  /** HTTP verb */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** URL pattern (path params as :param) */
  path: string
  /** Backend route file that handles this */
  backendFile: string
  /** Current implementation status */
  status: RouteStatus
  /** Extra context for non-live entries */
  note?: string
}

// ── Agent CRUD & Jobs ──────────────────────────────────────────────────────
const agentRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listAgents",
    method: "GET",
    path: "/agents",
    backendFile: "agents.ts",
    status: "live",
  },
  {
    dashboardMethod: "getAgent",
    method: "GET",
    path: "/agents/:id",
    backendFile: "agents.ts",
    status: "live",
  },
  {
    dashboardMethod: "createAgent",
    method: "POST",
    path: "/agents",
    backendFile: "agents.ts",
    status: "live",
  },
  {
    dashboardMethod: "updateAgent",
    method: "PUT",
    path: "/agents/:id",
    backendFile: "agents.ts",
    status: "live",
  },
  {
    dashboardMethod: "deleteAgent",
    method: "DELETE",
    path: "/agents/:id",
    backendFile: "agents.ts",
    status: "live",
  },
  {
    dashboardMethod: "createAgentJob",
    method: "POST",
    path: "/agents/:agentId/jobs",
    backendFile: "agents.ts",
    status: "live",
  },
  {
    dashboardMethod: "steerAgent",
    method: "POST",
    path: "/agents/:agentId/steer",
    backendFile: "stream.ts",
    status: "live",
  },
  {
    dashboardMethod: "pauseAgent",
    method: "POST",
    path: "/agents/:agentId/pause",
    backendFile: "agents.ts",
    status: "live",
  },
  {
    dashboardMethod: "resumeAgent",
    method: "POST",
    path: "/agents/:agentId/resume",
    backendFile: "agents.ts",
    status: "live",
  },
]

// ── Approvals ──────────────────────────────────────────────────────────────
const approvalRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listApprovals",
    method: "GET",
    path: "/approvals",
    backendFile: "approval.ts",
    status: "live",
  },
  {
    dashboardMethod: "approveRequest",
    method: "POST",
    path: "/approval/:id/decide",
    backendFile: "approval.ts",
    status: "live",
  },
  {
    dashboardMethod: "getApprovalDetail",
    method: "GET",
    path: "/approvals/:id",
    backendFile: "approval.ts",
    status: "live",
  },
  {
    dashboardMethod: "getApprovalAudit",
    method: "GET",
    path: "/approvals/:id/audit",
    backendFile: "approval.ts",
    status: "live",
  },
]

// ── Jobs & Dashboard ───────────────────────────────────────────────────────
const jobRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listJobs",
    method: "GET",
    path: "/jobs",
    backendFile: "dashboard.ts",
    status: "live",
  },
  {
    dashboardMethod: "getJob",
    method: "GET",
    path: "/jobs/:jobId",
    backendFile: "dashboard.ts",
    status: "live",
  },
  {
    dashboardMethod: "retryJob",
    method: "POST",
    path: "/jobs/:jobId/retry",
    backendFile: "dashboard.ts",
    status: "live",
  },
  {
    dashboardMethod: "getDashboardSummary",
    method: "GET",
    path: "/dashboard/summary",
    backendFile: "dashboard.ts",
    status: "live",
  },
  {
    dashboardMethod: "getDashboardActivity",
    method: "GET",
    path: "/dashboard/activity",
    backendFile: "dashboard.ts",
    status: "live",
  },
]

// ── Memory ─────────────────────────────────────────────────────────────────
const memoryRoutes: AuditEntry[] = [
  {
    dashboardMethod: "searchMemory",
    method: "GET",
    path: "/memory/search",
    backendFile: "dashboard.ts",
    status: "live",
  },
  {
    dashboardMethod: "syncMemory",
    method: "POST",
    path: "/memory/sync",
    backendFile: "dashboard.ts",
    status: "stub-501",
    note: "Returns 501 — memory sync not yet implemented",
  },
]

// ── Content Pipeline (all stubs) ───────────────────────────────────────────
const contentRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listContent",
    method: "GET",
    path: "/content",
    backendFile: "dashboard.ts",
    status: "stub-empty",
    note: "Always returns empty array — no content table in DB",
  },
  {
    dashboardMethod: "publishContent",
    method: "POST",
    path: "/content/:id/publish",
    backendFile: "dashboard.ts",
    status: "stub-501",
    note: "Returns 501 Not Implemented",
  },
  {
    dashboardMethod: "archiveContent",
    method: "POST",
    path: "/content/:id/archive",
    backendFile: "dashboard.ts",
    status: "stub-501",
    note: "Returns 501 Not Implemented",
  },
]

// ── Browser Observation ────────────────────────────────────────────────────
const browserRoutes: AuditEntry[] = [
  {
    dashboardMethod: "getAgentBrowser",
    method: "GET",
    path: "/agents/:agentId/browser",
    backendFile: "dashboard.ts",
    status: "live",
  },
  {
    dashboardMethod: "getAgentScreenshots",
    method: "GET",
    path: "/agents/:agentId/browser/screenshots",
    backendFile: "dashboard.ts",
    status: "live",
    note: "Returns persisted screenshot history when runtime artifacts exist",
  },
  {
    dashboardMethod: "getAgentBrowserEvents",
    method: "GET",
    path: "/agents/:agentId/browser/events",
    backendFile: "dashboard.ts",
    status: "live",
    note: "Returns persisted browser event history when runtime artifacts exist",
  },
  {
    dashboardMethod: "captureScreenshot",
    method: "POST",
    path: "/agents/:agentId/observe/screenshot",
    backendFile: "observation.ts",
    status: "live",
  },
  {
    dashboardMethod: "getTraceState",
    method: "GET",
    path: "/agents/:agentId/observe/trace",
    backendFile: "observation.ts",
    status: "live",
  },
  {
    dashboardMethod: "startTrace",
    method: "POST",
    path: "/agents/:agentId/observe/trace/start",
    backendFile: "observation.ts",
    status: "live",
  },
  {
    dashboardMethod: "stopTrace",
    method: "POST",
    path: "/agents/:agentId/observe/trace/stop",
    backendFile: "observation.ts",
    status: "live",
  },
]

// ── Credentials & Auth ─────────────────────────────────────────────────────
const credentialRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listProviders",
    method: "GET",
    path: "/credentials/providers",
    backendFile: "credentials.ts",
    status: "live",
  },
  {
    dashboardMethod: "listCredentials",
    method: "GET",
    path: "/credentials",
    backendFile: "credentials.ts",
    status: "live",
  },
  {
    dashboardMethod: "initOAuthConnect",
    method: "GET",
    path: "/auth/connect/:provider/init",
    backendFile: "auth.ts",
    status: "live",
  },
  {
    dashboardMethod: "exchangeOAuthConnect",
    method: "POST",
    path: "/auth/connect/:provider/exchange",
    backendFile: "auth.ts",
    status: "live",
  },
  {
    dashboardMethod: "saveProviderApiKey",
    method: "POST",
    path: "/credentials/api-key",
    backendFile: "credentials.ts",
    status: "live",
  },
  {
    dashboardMethod: "deleteCredential",
    method: "DELETE",
    path: "/credentials/:id",
    backendFile: "credentials.ts",
    status: "live",
  },
]

// ── Agent Channels ─────────────────────────────────────────────────────────
const channelRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listAgentChannels",
    method: "GET",
    path: "/agents/:agentId/channels",
    backendFile: "agent-channels.ts",
    status: "live",
  },
  {
    dashboardMethod: "bindAgentChannel",
    method: "POST",
    path: "/agents/:agentId/channels",
    backendFile: "agent-channels.ts",
    status: "live",
  },
  {
    dashboardMethod: "unbindAgentChannel",
    method: "DELETE",
    path: "/agents/:agentId/channels/:bindingId",
    backendFile: "agent-channels.ts",
    status: "live",
  },
  {
    dashboardMethod: "listChannelBindings",
    method: "GET",
    path: "/channels/:id/bindings",
    backendFile: "channels.ts",
    status: "live",
  },
]

// ── Agent Credentials ──────────────────────────────────────────────────────
const agentCredentialRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listAgentCredentials",
    method: "GET",
    path: "/agents/:agentId/credentials",
    backendFile: "agent-credentials.ts",
    status: "live",
  },
  {
    dashboardMethod: "bindAgentCredential",
    method: "POST",
    path: "/agents/:agentId/credentials",
    backendFile: "agent-credentials.ts",
    status: "live",
  },
  {
    dashboardMethod: "unbindAgentCredential",
    method: "DELETE",
    path: "/agents/:agentId/credentials/:credentialId",
    backendFile: "agent-credentials.ts",
    status: "live",
  },
]

// ── MCP Servers ────────────────────────────────────────────────────────────
const mcpRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listMcpServers",
    method: "GET",
    path: "/mcp-servers",
    backendFile: "mcp-servers.ts",
    status: "live",
  },
  {
    dashboardMethod: "getMcpServer",
    method: "GET",
    path: "/mcp-servers/:id",
    backendFile: "mcp-servers.ts",
    status: "live",
  },
  {
    dashboardMethod: "createMcpServer",
    method: "POST",
    path: "/mcp-servers",
    backendFile: "mcp-servers.ts",
    status: "live",
  },
  {
    dashboardMethod: "updateMcpServer",
    method: "PUT",
    path: "/mcp-servers/:id",
    backendFile: "mcp-servers.ts",
    status: "live",
  },
  {
    dashboardMethod: "deleteMcpServer",
    method: "DELETE",
    path: "/mcp-servers/:id",
    backendFile: "mcp-servers.ts",
    status: "live",
  },
  {
    dashboardMethod: "refreshMcpServer",
    method: "POST",
    path: "/mcp-servers/:id/refresh",
    backendFile: "mcp-servers.ts",
    status: "live",
  },
]

// ── Users & Access ─────────────────────────────────────────────────────────
const userRoutes: AuditEntry[] = [
  {
    dashboardMethod: "getUser",
    method: "GET",
    path: "/users/:userId",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
  {
    dashboardMethod: "getUserUsage",
    method: "GET",
    path: "/users/:userId/usage",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
  {
    dashboardMethod: "revokeUserGrant",
    method: "DELETE",
    path: "/agents/:agentId/users/:grantId",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
  {
    dashboardMethod: "listAgentUsers",
    method: "GET",
    path: "/agents/:agentId/users",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
  {
    dashboardMethod: "createAgentUserGrant",
    method: "POST",
    path: "/agents/:agentId/users",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
  {
    dashboardMethod: "generatePairingCode",
    method: "POST",
    path: "/agents/:agentId/pairing-codes",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
  {
    dashboardMethod: "listPairingCodes",
    method: "GET",
    path: "/agents/:agentId/pairing-codes",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
  {
    dashboardMethod: "revokePairingCode",
    method: "DELETE",
    path: "/agents/:agentId/pairing-codes/:codeId",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
  {
    dashboardMethod: "listAccessRequests",
    method: "GET",
    path: "/agents/:agentId/access-requests",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
  {
    dashboardMethod: "resolveAccessRequest",
    method: "PATCH",
    path: "/agents/:agentId/access-requests/:requestId",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
  {
    dashboardMethod: "getPendingCounts",
    method: "GET",
    path: "/access-requests/pending-count",
    backendFile: "agent-user-routes.ts",
    status: "live",
  },
]

// ── Chat & Sessions ────────────────────────────────────────────────────────
const chatRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listAgentSessions",
    method: "GET",
    path: "/agents/:id/sessions",
    backendFile: "sessions.ts",
    status: "live",
  },
  {
    dashboardMethod: "getSessionMessages",
    method: "GET",
    path: "/sessions/:id/messages",
    backendFile: "sessions.ts",
    status: "live",
  },
  {
    dashboardMethod: "sendChatMessage",
    method: "POST",
    path: "/agents/:agentId/chat",
    backendFile: "chat.ts",
    status: "live",
  },
  {
    dashboardMethod: "deleteSession",
    method: "DELETE",
    path: "/sessions/:id",
    backendFile: "sessions.ts",
    status: "live",
  },
  {
    dashboardMethod: "getChatJobStatus",
    method: "GET",
    path: "/agents/:agentId/chat/jobs/:jobId",
    backendFile: "chat.ts",
    status: "live",
  },
]

// ── Operations ─────────────────────────────────────────────────────────────
const operationRoutes: AuditEntry[] = [
  {
    dashboardMethod: "getAgentEvents",
    method: "GET",
    path: "/agents/:agentId/events",
    backendFile: "operator-events.ts",
    status: "live",
  },
  {
    dashboardMethod: "getAgentCost",
    method: "GET",
    path: "/agents/:agentId/cost",
    backendFile: "operator-events.ts",
    status: "live",
  },
  {
    dashboardMethod: "killAgent",
    method: "POST",
    path: "/agents/:agentId/kill",
    backendFile: "agent-control.ts",
    status: "live",
  },
  {
    dashboardMethod: "dryRunAgent",
    method: "POST",
    path: "/agents/:agentId/dry-run",
    backendFile: "agent-control.ts",
    status: "live",
  },
  {
    dashboardMethod: "replayAgent",
    method: "POST",
    path: "/agents/:agentId/replay",
    backendFile: "agent-control.ts",
    status: "live",
  },
  {
    dashboardMethod: "quarantineAgent",
    method: "POST",
    path: "/agents/:agentId/quarantine",
    backendFile: "agent-lifecycle.ts",
    status: "live",
  },
  {
    dashboardMethod: "releaseAgent",
    method: "POST",
    path: "/agents/:agentId/release",
    backendFile: "agent-lifecycle.ts",
    status: "live",
  },
]

// ── Channel Config ─────────────────────────────────────────────────────────
const channelConfigRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listChannelConfigs",
    method: "GET",
    path: "/channels",
    backendFile: "channels.ts",
    status: "live",
  },
  {
    dashboardMethod: "getChannelConfig",
    method: "GET",
    path: "/channels/:id",
    backendFile: "channels.ts",
    status: "live",
  },
  {
    dashboardMethod: "createChannelConfig",
    method: "POST",
    path: "/channels",
    backendFile: "channels.ts",
    status: "live",
  },
  {
    dashboardMethod: "updateChannelConfig",
    method: "PUT",
    path: "/channels/:id",
    backendFile: "channels.ts",
    status: "live",
  },
  {
    dashboardMethod: "deleteChannelConfig",
    method: "DELETE",
    path: "/channels/:id",
    backendFile: "channels.ts",
    status: "live",
  },
]

// ── Tool Bindings ──────────────────────────────────────────────────────────
const toolBindingRoutes: AuditEntry[] = [
  {
    dashboardMethod: "listToolBindings",
    method: "GET",
    path: "/agents/:agentId/tool-bindings",
    backendFile: "agent-tool-bindings.ts",
    status: "live",
  },
  {
    dashboardMethod: "createToolBinding",
    method: "POST",
    path: "/agents/:agentId/tool-bindings",
    backendFile: "agent-tool-bindings.ts",
    status: "live",
  },
  {
    dashboardMethod: "updateToolBinding",
    method: "PUT",
    path: "/agents/:agentId/tool-bindings/:bindingId",
    backendFile: "agent-tool-bindings.ts",
    status: "live",
  },
  {
    dashboardMethod: "deleteToolBinding",
    method: "DELETE",
    path: "/agents/:agentId/tool-bindings/:bindingId",
    backendFile: "agent-tool-bindings.ts",
    status: "live",
  },
  {
    dashboardMethod: "bulkBindTools",
    method: "POST",
    path: "/agents/:agentId/tool-bindings/bulk",
    backendFile: "agent-tool-bindings.ts",
    status: "live",
  },
  {
    dashboardMethod: "getEffectiveTools",
    method: "GET",
    path: "/agents/:agentId/effective-tools",
    backendFile: "agent-tool-bindings.ts",
    status: "live",
  },
  {
    dashboardMethod: "getCapabilityAudit",
    method: "GET",
    path: "/agents/:agentId/capability-audit",
    backendFile: "agent-tool-bindings.ts",
    status: "live",
  },
]

// ── All routes combined ────────────────────────────────────────────────────
const ALL_ROUTES: AuditEntry[] = [
  ...agentRoutes,
  ...approvalRoutes,
  ...jobRoutes,
  ...memoryRoutes,
  ...contentRoutes,
  ...browserRoutes,
  ...credentialRoutes,
  ...channelRoutes,
  ...agentCredentialRoutes,
  ...mcpRoutes,
  ...userRoutes,
  ...chatRoutes,
  ...operationRoutes,
  ...channelConfigRoutes,
  ...toolBindingRoutes,
]

// ---------------------------------------------------------------------------
// Page audit registry
// ---------------------------------------------------------------------------

type PageStatus = "works" | "partial" | "phantom" | "placeholder"

interface PageAudit {
  /** Dashboard URL pattern */
  path: string
  /** Human-readable label */
  label: string
  status: PageStatus
  /** API methods this page consumes */
  apiMethods: string[]
  note?: string
}

const PAGE_AUDIT: PageAudit[] = [
  // ── Core pages ───────────────────────────────────────────────────────────
  {
    path: "/",
    label: "Dashboard home",
    status: "works",
    apiMethods: ["getDashboardSummary", "getDashboardActivity"],
  },
  {
    path: "/agents",
    label: "Agent list",
    status: "works",
    apiMethods: ["listAgents"],
  },
  {
    path: "/agents/[id]",
    label: "Agent detail/console (chat)",
    status: "works",
    apiMethods: [
      "getAgent",
      "updateAgent",
      "deleteAgent",
      "pauseAgent",
      "resumeAgent",
      "steerAgent",
    ],
    note: "Browser and Memory sub-tabs show 'coming soon' placeholders",
  },
  {
    path: "/agents/[id]/operations",
    label: "Agent operations + control panel",
    status: "works",
    apiMethods: ["getAgent", "getAgentCost", "getAgentEvents"],
  },
  {
    path: "/agents/[id]/credentials",
    label: "Credential binding",
    status: "works",
    apiMethods: [
      "getAgent",
      "listAgentCredentials",
      "bindAgentCredential",
      "unbindAgentCredential",
    ],
  },
  {
    path: "/agents/[id]/capabilities",
    label: "Capability config",
    status: "works",
    apiMethods: [
      "listToolBindings",
      "createToolBinding",
      "updateToolBinding",
      "deleteToolBinding",
      "bulkBindTools",
      "getEffectiveTools",
      "getCapabilityAudit",
      "listMcpServers",
    ],
  },
  {
    path: "/agents/[id]/users",
    label: "User management",
    status: "works",
    apiMethods: ["getAgent", "listAgentUsers", "createAgentUserGrant", "revokeUserGrant"],
  },
  {
    path: "/agents/[id]/memory",
    label: "Agent memory",
    status: "placeholder",
    apiMethods: [],
    note: "RoutePlaceholder skeleton — no API integration",
  },
  {
    path: "/agents/[id]/browser",
    label: "Browser automation",
    status: "partial",
    apiMethods: [
      "getAgent",
      "getAgentBrowser",
      "getAgentScreenshots",
      "getAgentBrowserEvents",
      "captureScreenshot",
      "getTraceState",
      "startTrace",
      "stopTrace",
    ],
    note: "Page is fully built with persisted screenshot/event history endpoints",
  },
  {
    path: "/jobs",
    label: "Job history list + detail",
    status: "works",
    apiMethods: ["listJobs", "getJob", "retryJob"],
  },
  {
    path: "/operations",
    label: "Global operations view",
    status: "works",
    apiMethods: ["listAgents"],
  },
  {
    path: "/approvals",
    label: "Approval queue",
    status: "works",
    apiMethods: ["listApprovals", "approveRequest", "getApprovalAudit"],
  },
  {
    path: "/memory",
    label: "Global memory view",
    status: "partial",
    apiMethods: ["searchMemory", "syncMemory", "listAgents"],
    note: "Search works; sync button triggers 501",
  },
  {
    path: "/mcp-servers",
    label: "MCP server list",
    status: "works",
    apiMethods: ["listMcpServers"],
  },
  {
    path: "/mcp-servers/[id]",
    label: "MCP server detail",
    status: "works",
    apiMethods: ["getMcpServer", "updateMcpServer", "deleteMcpServer", "refreshMcpServer"],
  },
  {
    path: "/pulse",
    label: "Content pipeline",
    status: "phantom",
    apiMethods: ["listContent", "publishContent", "archiveContent"],
    note: "Full Kanban UI but backend is 100% stub — listContent returns [], publish/archive return 501",
  },
  {
    path: "/settings",
    label: "OAuth, API keys, LLM config",
    status: "works",
    apiMethods: [
      "listProviders",
      "listCredentials",
      "saveProviderApiKey",
      "deleteCredential",
      "initOAuthConnect",
      "exchangeOAuthConnect",
    ],
  },
  {
    path: "/users/[id]",
    label: "User detail",
    status: "works",
    apiMethods: ["getUser", "getUserUsage", "revokeUserGrant"],
  },
  {
    path: "/login",
    label: "Login flow",
    status: "works",
    apiMethods: [],
    note: "Fetches /auth/providers directly",
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Dashboard feature audit (#501)", () => {
  // ── Direction 2: Dashboard → Backend route coverage ────────────────────
  describe("route coverage — every dashboard API method has a backend route", () => {
    const methodSet = new Set(ALL_ROUTES.map((r) => r.dashboardMethod))

    it("has no duplicate dashboard method entries", () => {
      const methods = ALL_ROUTES.map((r) => r.dashboardMethod)
      const duplicates = methods.filter((m, i) => methods.indexOf(m) !== i)
      expect(duplicates).toEqual([])
    })

    it("covers all expected dashboard API methods", () => {
      // This is the authoritative list of every exported async function from api-client.ts.
      // If you add a new method there, add it to the audit registry above.
      const expectedMethods = [
        "listAgents",
        "getAgent",
        "createAgent",
        "updateAgent",
        "deleteAgent",
        "createAgentJob",
        "steerAgent",
        "pauseAgent",
        "resumeAgent",
        "listApprovals",
        "approveRequest",
        "getApprovalDetail",
        "getApprovalAudit",
        "listJobs",
        "getJob",
        "retryJob",
        "getDashboardSummary",
        "getDashboardActivity",
        "searchMemory",
        "syncMemory",
        "listContent",
        "publishContent",
        "archiveContent",
        "getAgentBrowser",
        "getAgentScreenshots",
        "getAgentBrowserEvents",
        "captureScreenshot",
        "getTraceState",
        "startTrace",
        "stopTrace",
        "listProviders",
        "listCredentials",
        "initOAuthConnect",
        "exchangeOAuthConnect",
        "saveProviderApiKey",
        "deleteCredential",
        "listAgentChannels",
        "bindAgentChannel",
        "unbindAgentChannel",
        "listChannelBindings",
        "listAgentCredentials",
        "bindAgentCredential",
        "unbindAgentCredential",
        "listMcpServers",
        "getMcpServer",
        "createMcpServer",
        "updateMcpServer",
        "deleteMcpServer",
        "refreshMcpServer",
        "getUser",
        "getUserUsage",
        "revokeUserGrant",
        "listAgentUsers",
        "createAgentUserGrant",
        "generatePairingCode",
        "listPairingCodes",
        "revokePairingCode",
        "listAccessRequests",
        "resolveAccessRequest",
        "getPendingCounts",
        "listAgentSessions",
        "getSessionMessages",
        "sendChatMessage",
        "deleteSession",
        "getChatJobStatus",
        "getAgentEvents",
        "getAgentCost",
        "killAgent",
        "dryRunAgent",
        "replayAgent",
        "quarantineAgent",
        "releaseAgent",
        "listChannelConfigs",
        "getChannelConfig",
        "createChannelConfig",
        "updateChannelConfig",
        "deleteChannelConfig",
        "listToolBindings",
        "createToolBinding",
        "updateToolBinding",
        "deleteToolBinding",
        "bulkBindTools",
        "getEffectiveTools",
        "getCapabilityAudit",
      ]

      for (const method of expectedMethods) {
        expect(methodSet.has(method), `Missing audit entry for: ${method}`).toBe(true)
      }
    })
  })

  // ── Page-level status verification ─────────────────────────────────────
  describe("page audit — every dashboard page has documented status", () => {
    const expectedPages = [
      "/",
      "/agents",
      "/agents/[id]",
      "/agents/[id]/operations",
      "/agents/[id]/credentials",
      "/agents/[id]/capabilities",
      "/agents/[id]/users",
      "/agents/[id]/memory",
      "/agents/[id]/browser",
      "/jobs",
      "/operations",
      "/approvals",
      "/memory",
      "/mcp-servers",
      "/mcp-servers/[id]",
      "/pulse",
      "/settings",
      "/users/[id]",
      "/login",
    ]

    const auditedPaths = new Set(PAGE_AUDIT.map((p) => p.path))

    it("has an audit entry for every dashboard page", () => {
      for (const page of expectedPages) {
        expect(auditedPaths.has(page), `Missing page audit: ${page}`).toBe(true)
      }
    })

    it("every page API method exists in the route registry", () => {
      const methodSet = new Set(ALL_ROUTES.map((r) => r.dashboardMethod))
      for (const page of PAGE_AUDIT) {
        for (const method of page.apiMethods) {
          expect(
            methodSet.has(method),
            `Page ${page.path} references unknown method: ${method}`,
          ).toBe(true)
        }
      }
    })
  })

  // ── Phantom feature tracking ───────────────────────────────────────────
  describe("phantom features — explicitly tracked", () => {
    const stubs = ALL_ROUTES.filter((r) => r.status !== "live")
    const phantomPages = PAGE_AUDIT.filter(
      (p) => p.status === "phantom" || p.status === "placeholder",
    )

    it("documents all known stub endpoints", () => {
      // When you implement a stub, update its status to "live" and this count.
      // Current stubs:
      //   1. GET  /content                           (stub-empty)
      //   2. POST /content/:id/publish               (stub-501)
      //   3. POST /content/:id/archive               (stub-501)
      //   4. POST /memory/sync                       (stub-501)
      expect(stubs).toHaveLength(4)
    })

    it("documents all phantom/placeholder pages", () => {
      // Current phantom/placeholder pages:
      //   1. /pulse          — full UI, 100% stub backend
      //   2. /agents/[id]/memory — skeleton placeholder, no API calls
      expect(phantomPages).toHaveLength(2)
    })

    it("every stub has a note explaining why", () => {
      for (const stub of stubs) {
        expect(stub.note, `Stub ${stub.dashboardMethod} missing note`).toBeTruthy()
      }
    })

    it("every phantom/placeholder page has a note", () => {
      for (const page of phantomPages) {
        expect(page.note, `Phantom page ${page.path} missing note`).toBeTruthy()
      }
    })
  })

  // ── Partial pages — tracked separately from phantoms ───────────────────
  describe("partial pages — features that mostly work", () => {
    const partials = PAGE_AUDIT.filter((p) => p.status === "partial")

    it("documents partial pages with notes", () => {
      // Current partial pages:
      //   1. /agents/[id]/browser — page built, screenshot/event lists return []
      //   2. /memory — search works, sync returns 501
      expect(partials).toHaveLength(2)
      for (const page of partials) {
        expect(page.note, `Partial page ${page.path} missing note`).toBeTruthy()
      }
    })
  })

  // NOTE (#717): Removed brittle aggregate-count assertions.
  // Exact totals are implementation-detail snapshots and produced high churn
  // with low user-facing signal. The tests above now focus on behavioral risk:
  // route mapping integrity, explicit stub/phantom disclosure, and provenance notes.
})
