import { afterEach, describe, expect, it, vi } from "vitest"

import {
  bindAgentChannel,
  bindAgentCredential,
  createAgent,
  createChannelConfig,
  deleteChannelConfig,
  deleteCredential,
  listAgentCredentials,
  listChannelBindings,
  listChannelConfigs,
  listCredentials,
  listProviders,
  saveProviderApiKey,
  unbindAgentChannel,
  unbindAgentCredential,
  updateChannelConfig,
} from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchResponse(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: () => Promise.resolve(body),
    }),
  )
}

function mockFetchRejection(message: string): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(message)))
}

// ---------------------------------------------------------------------------
// Tests: every API function used by dashboard components should throw on
// network/server errors so that catch blocks can surface feedback.
// ---------------------------------------------------------------------------

describe("Dashboard API error propagation", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // ---- Credential binding ----

  describe("listAgentCredentials", () => {
    it("throws on server error", async () => {
      mockFetchResponse({ error: "Internal Server Error" }, 500)
      await expect(listAgentCredentials("agent-1")).rejects.toThrow()
    })

    it("throws on network failure", async () => {
      mockFetchRejection("Network error")
      await expect(listAgentCredentials("agent-1")).rejects.toThrow(
        "Could not connect to the control plane",
      )
    })
  })

  describe("listCredentials", () => {
    it("throws on server error", async () => {
      mockFetchResponse({ error: "Unauthorized" }, 401)
      await expect(listCredentials()).rejects.toThrow()
    })
  })

  describe("bindAgentCredential", () => {
    it("throws on 409 conflict", async () => {
      mockFetchResponse({ error: "Already bound" }, 409)
      await expect(bindAgentCredential("agent-1", "cred-1")).rejects.toThrow()
    })

    it("returns successfully on 200", async () => {
      mockFetchResponse({ id: "binding-1" })
      const result = await bindAgentCredential("agent-1", "cred-1")
      expect(result).toBeDefined()
    })
  })

  describe("unbindAgentCredential", () => {
    it("throws on server error", async () => {
      mockFetchResponse({ error: "Not found" }, 404)
      await expect(unbindAgentCredential("agent-1", "cred-1")).rejects.toThrow()
    })
  })

  // ---- Channel config ----

  describe("listChannelConfigs", () => {
    it("throws on server error", async () => {
      mockFetchResponse({ error: "Service unavailable" }, 503)
      await expect(listChannelConfigs()).rejects.toThrow()
    })
  })

  describe("createChannelConfig", () => {
    it("throws on validation error", async () => {
      mockFetchResponse({ error: "Invalid config" }, 400)
      await expect(
        createChannelConfig({ type: "telegram", name: "test", config: {} }),
      ).rejects.toThrow()
    })
  })

  describe("updateChannelConfig", () => {
    it("throws on not found", async () => {
      mockFetchResponse({ error: "Channel not found" }, 404)
      await expect(updateChannelConfig("ch-1", { enabled: true })).rejects.toThrow()
    })
  })

  describe("deleteChannelConfig", () => {
    it("throws on 409 conflict (bound agents)", async () => {
      mockFetchResponse({ error: "Channel has active bindings. Use force=true to override." }, 409)
      await expect(deleteChannelConfig("ch-1")).rejects.toThrow()
    })

    it("succeeds with force flag", async () => {
      mockFetchResponse({ id: "ch-1", deleted: true })
      const result = await deleteChannelConfig("ch-1", { force: true })
      expect(result).toBeDefined()
    })
  })

  describe("listChannelBindings", () => {
    it("throws on server error", async () => {
      mockFetchResponse({ error: "Internal error" }, 500)
      await expect(listChannelBindings("ch-1")).rejects.toThrow()
    })
  })

  describe("bindAgentChannel", () => {
    it("throws on missing agent", async () => {
      mockFetchResponse({ error: "Agent not found" }, 404)
      await expect(bindAgentChannel("agent-1", "telegram", "123")).rejects.toThrow()
    })
  })

  describe("unbindAgentChannel", () => {
    it("throws on server error", async () => {
      mockFetchResponse({ error: "Failed" }, 500)
      await expect(unbindAgentChannel("agent-1", "binding-1")).rejects.toThrow()
    })
  })

  // ---- Settings / credentials ----

  describe("listProviders", () => {
    it("throws on auth error", async () => {
      mockFetchResponse({ error: "Unauthorized" }, 401)
      await expect(listProviders()).rejects.toThrow()
    })
  })

  describe("saveProviderApiKey", () => {
    it("throws on validation error", async () => {
      mockFetchResponse({ error: "Invalid key" }, 400)
      await expect(saveProviderApiKey({ provider: "openai", apiKey: "bad" })).rejects.toThrow()
    })
  })

  describe("deleteCredential", () => {
    it("throws on not found", async () => {
      mockFetchResponse({ error: "Credential not found" }, 404)
      await expect(deleteCredential("cred-1")).rejects.toThrow()
    })
  })

  // ---- Agent deployment ----

  describe("createAgent", () => {
    it("throws on validation error", async () => {
      mockFetchResponse({ error: "Name already taken" }, 409)
      await expect(createAgent({ name: "dup", role: "test" })).rejects.toThrow()
    })

    it("returns agent on success", async () => {
      mockFetchResponse({ id: "agent-new", name: "Test Agent", slug: "test-agent" })
      const result = (await createAgent({ name: "Test Agent", role: "tester" })) as {
        id: string
      }
      expect(result.id).toBe("agent-new")
    })
  })
})

// ---------------------------------------------------------------------------
// Tests: error message extraction pattern used across components
// ---------------------------------------------------------------------------

describe("Error message extraction pattern", () => {
  it("extracts message from Error instances", () => {
    const err = new Error("Something went wrong")
    const msg = err instanceof Error ? err.message : "Unknown error"
    expect(msg).toBe("Something went wrong")
  })

  it("falls back for non-Error objects", () => {
    const err: unknown = "string error"
    const msg = err instanceof Error ? err.message : "Failed to perform action"
    expect(msg).toBe("Failed to perform action")
  })

  it("handles null/undefined errors gracefully", () => {
    const err: unknown = null
    const msg = err instanceof Error ? err.message : "An error occurred"
    expect(msg).toBe("An error occurred")
  })
})
