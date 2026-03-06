import { describe, expect, it, vi } from "vitest"

import {
  buildDeployment,
  buildService,
  buildServiceAccount,
  type McpServerDeploymentConfig,
} from "../mcp/k8s-deployer.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<McpServerDeploymentConfig> = {}): McpServerDeploymentConfig {
  return {
    slug: "github",
    image: "ghcr.io/modelcontextprotocol/server-github:latest",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildDeployment
// ---------------------------------------------------------------------------

describe("buildDeployment", () => {
  it("creates a Deployment with correct metadata", () => {
    const dep = buildDeployment(makeConfig())

    expect(dep.apiVersion).toBe("apps/v1")
    expect(dep.kind).toBe("Deployment")
    expect(dep.metadata?.name).toBe("mcp-server-github")
    expect(dep.metadata?.namespace).toBe("cortex-plane")
    expect(dep.metadata?.labels).toEqual(
      expect.objectContaining({
        "app.kubernetes.io/managed-by": "cortex-plane",
        "cortex.io/mcp-server": "github",
      }) as Record<string, string>,
    )
  })

  it("uses custom namespace", () => {
    const dep = buildDeployment(makeConfig({ namespace: "custom-ns" }))
    expect(dep.metadata?.namespace).toBe("custom-ns")
  })

  it("sets replica count to 1", () => {
    const dep = buildDeployment(makeConfig())
    expect(dep.spec?.replicas).toBe(1)
  })

  it("uses matching label selector", () => {
    const dep = buildDeployment(makeConfig())
    expect(dep.spec?.selector?.matchLabels).toEqual({
      "cortex.io/mcp-server": "github",
    })
  })

  it("configures security context (non-root, read-only FS)", () => {
    const dep = buildDeployment(makeConfig())
    const podSec = dep.spec?.template?.spec?.securityContext

    expect(podSec?.runAsNonRoot).toBe(true)
    expect(podSec?.runAsUser).toBe(1000)
    expect(podSec?.seccompProfile?.type).toBe("RuntimeDefault")

    const containerSec = dep.spec?.template?.spec?.containers?.[0]?.securityContext
    expect(containerSec?.allowPrivilegeEscalation).toBe(false)
    expect(containerSec?.readOnlyRootFilesystem).toBe(true)
    expect(containerSec?.capabilities?.drop).toEqual(["ALL"])
  })

  it("uses default port 3000", () => {
    const dep = buildDeployment(makeConfig())
    const container = dep.spec?.template?.spec?.containers?.[0]
    expect(container?.ports?.[0]?.containerPort).toBe(3000)
  })

  it("uses custom port", () => {
    const dep = buildDeployment(makeConfig({ port: 8080 }))
    const container = dep.spec?.template?.spec?.containers?.[0]
    expect(container?.ports?.[0]?.containerPort).toBe(8080)
  })

  it("uses default resource requests/limits", () => {
    const dep = buildDeployment(makeConfig())
    const container = dep.spec?.template?.spec?.containers?.[0]

    expect(container?.resources?.requests).toEqual({ cpu: "100m", memory: "128Mi" })
    expect(container?.resources?.limits).toEqual({ cpu: "100m", memory: "128Mi" })
  })

  it("uses custom resource requests/limits", () => {
    const dep = buildDeployment(makeConfig({ resources: { cpu: "500m", memory: "512Mi" } }))
    const container = dep.spec?.template?.spec?.containers?.[0]

    expect(container?.resources?.requests).toEqual({ cpu: "500m", memory: "512Mi" })
    expect(container?.resources?.limits).toEqual({ cpu: "500m", memory: "512Mi" })
  })

  it("injects environment variables", () => {
    const dep = buildDeployment(
      makeConfig({ env: { GITHUB_TOKEN: "tok-123", LOG_LEVEL: "debug" } }),
    )
    const container = dep.spec?.template?.spec?.containers?.[0]

    expect(container?.env).toEqual([
      { name: "GITHUB_TOKEN", value: "tok-123" },
      { name: "LOG_LEVEL", value: "debug" },
    ])
  })

  it("has empty env when not provided", () => {
    const dep = buildDeployment(makeConfig())
    const container = dep.spec?.template?.spec?.containers?.[0]
    expect(container?.env).toEqual([])
  })

  it("configures liveness and readiness probes on /mcp", () => {
    const dep = buildDeployment(makeConfig())
    const container = dep.spec?.template?.spec?.containers?.[0]

    expect(container?.livenessProbe?.httpGet?.path).toBe("/mcp")
    expect(container?.livenessProbe?.httpGet?.port).toBe(3000)
    expect(container?.readinessProbe?.httpGet?.path).toBe("/mcp")
    expect(container?.readinessProbe?.httpGet?.port).toBe(3000)
  })

  it("probes use custom port", () => {
    const dep = buildDeployment(makeConfig({ port: 9090 }))
    const container = dep.spec?.template?.spec?.containers?.[0]

    expect(container?.livenessProbe?.httpGet?.port).toBe(9090)
    expect(container?.readinessProbe?.httpGet?.port).toBe(9090)
  })

  it("mounts tmp emptyDir volume", () => {
    const dep = buildDeployment(makeConfig())
    const container = dep.spec?.template?.spec?.containers?.[0]
    const volumes = dep.spec?.template?.spec?.volumes

    expect(container?.volumeMounts).toEqual([{ name: "tmp", mountPath: "/tmp" }])
    expect(volumes).toEqual([{ name: "tmp", emptyDir: { sizeLimit: "128Mi" } }])
  })

  it("sets automountServiceAccountToken to false", () => {
    const dep = buildDeployment(makeConfig())
    expect(dep.spec?.template?.spec?.automountServiceAccountToken).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildService
// ---------------------------------------------------------------------------

describe("buildService", () => {
  it("creates a ClusterIP Service", () => {
    const svc = buildService(makeConfig())

    expect(svc.apiVersion).toBe("v1")
    expect(svc.kind).toBe("Service")
    expect(svc.metadata?.name).toBe("mcp-server-github")
    expect(svc.metadata?.namespace).toBe("cortex-plane")
    expect(svc.spec?.type).toBe("ClusterIP")
  })

  it("has correct selector", () => {
    const svc = buildService(makeConfig())
    expect(svc.spec?.selector).toEqual({ "cortex.io/mcp-server": "github" })
  })

  it("exposes default port 3000", () => {
    const svc = buildService(makeConfig())
    expect(svc.spec?.ports?.[0]).toEqual({
      name: "http",
      port: 3000,
      targetPort: 3000,
      protocol: "TCP",
    })
  })

  it("exposes custom port", () => {
    const svc = buildService(makeConfig({ port: 8080 }))
    expect(svc.spec?.ports?.[0]?.port).toBe(8080)
    expect(svc.spec?.ports?.[0]?.targetPort).toBe(8080)
  })

  it("uses custom namespace", () => {
    const svc = buildService(makeConfig({ namespace: "test-ns" }))
    expect(svc.metadata?.namespace).toBe("test-ns")
  })

  it("has managed-by labels", () => {
    const svc = buildService(makeConfig())
    expect(svc.metadata?.labels).toEqual(
      expect.objectContaining({
        "app.kubernetes.io/managed-by": "cortex-plane",
        "cortex.io/mcp-server": "github",
      }) as Record<string, string>,
    )
  })
})

// ---------------------------------------------------------------------------
// buildServiceAccount
// ---------------------------------------------------------------------------

describe("buildServiceAccount", () => {
  it("creates a ServiceAccount with correct name", () => {
    const sa = buildServiceAccount(makeConfig())

    expect(sa.apiVersion).toBe("v1")
    expect(sa.kind).toBe("ServiceAccount")
    expect(sa.metadata?.name).toBe("mcp-server-github")
    expect(sa.metadata?.namespace).toBe("cortex-plane")
  })

  it("disables token auto-mount", () => {
    const sa = buildServiceAccount(makeConfig())
    expect(sa.automountServiceAccountToken).toBe(false)
  })

  it("has managed-by labels", () => {
    const sa = buildServiceAccount(makeConfig())
    expect(sa.metadata?.labels).toEqual(
      expect.objectContaining({
        "app.kubernetes.io/managed-by": "cortex-plane",
        "cortex.io/mcp-server": "github",
      }) as Record<string, string>,
    )
  })

  it("uses custom namespace", () => {
    const sa = buildServiceAccount(makeConfig({ namespace: "my-ns" }))
    expect(sa.metadata?.namespace).toBe("my-ns")
  })
})

// ---------------------------------------------------------------------------
// McpServerDeployer class (mock k8s API)
// ---------------------------------------------------------------------------

// We import the class separately to mock the k8s API layer
const mockAppsApi = {
  readNamespacedDeployment: vi.fn(),
  createNamespacedDeployment: vi.fn(),
  replaceNamespacedDeployment: vi.fn(),
  deleteNamespacedDeployment: vi.fn(),
}

const mockCoreApi = {
  readNamespacedServiceAccount: vi.fn(),
  createNamespacedServiceAccount: vi.fn(),
  replaceNamespacedServiceAccount: vi.fn(),
  deleteNamespacedServiceAccount: vi.fn(),
  readNamespacedService: vi.fn(),
  createNamespacedService: vi.fn(),
  replaceNamespacedService: vi.fn(),
  deleteNamespacedService: vi.fn(),
}

vi.mock("@kubernetes/client-node", () => {
  return {
    KubeConfig: class {
      loadFromDefault() {}
      makeApiClient(apiClass: unknown) {
        if (apiClass === AppsV1ApiRef) return mockAppsApi
        return mockCoreApi
      }
    },
    AppsV1Api: class {},
    CoreV1Api: class {},
  }
})

// Store refs for the mock check
const AppsV1ApiRef = (await import("@kubernetes/client-node")).AppsV1Api
const { McpServerDeployer } = await import("../mcp/k8s-deployer.js")

describe("McpServerDeployer", () => {
  function resetMocks() {
    vi.clearAllMocks()
    // Default: resources don't exist yet (404)
    mockAppsApi.readNamespacedDeployment.mockRejectedValue(new Error("not found"))
    mockAppsApi.createNamespacedDeployment.mockResolvedValue({})
    mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({})
    mockAppsApi.deleteNamespacedDeployment.mockResolvedValue({})
    mockCoreApi.readNamespacedServiceAccount.mockRejectedValue(new Error("not found"))
    mockCoreApi.createNamespacedServiceAccount.mockResolvedValue({})
    mockCoreApi.replaceNamespacedServiceAccount.mockResolvedValue({})
    mockCoreApi.deleteNamespacedServiceAccount.mockResolvedValue({})
    mockCoreApi.readNamespacedService.mockRejectedValue(new Error("not found"))
    mockCoreApi.createNamespacedService.mockResolvedValue({})
    mockCoreApi.replaceNamespacedService.mockResolvedValue({})
    mockCoreApi.deleteNamespacedService.mockResolvedValue({})
  }

  it("deploy() creates SA, Deployment, and Service (fresh)", async () => {
    resetMocks()
    const deployer = new McpServerDeployer()

    const result = await deployer.deploy(makeConfig())

    expect(result.url).toBe("http://mcp-server-github.cortex-plane.svc:3000/mcp")
    expect(result.deploymentName).toBe("mcp-server-github")
    expect(result.serviceName).toBe("mcp-server-github")

    expect(mockCoreApi.createNamespacedServiceAccount).toHaveBeenCalledTimes(1)
    expect(mockAppsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(mockCoreApi.createNamespacedService).toHaveBeenCalledTimes(1)
  })

  it("deploy() updates existing resources", async () => {
    resetMocks()
    // Resources already exist
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({})
    mockCoreApi.readNamespacedServiceAccount.mockResolvedValue({})
    mockCoreApi.readNamespacedService.mockResolvedValue({})

    const deployer = new McpServerDeployer()
    await deployer.deploy(makeConfig())

    expect(mockCoreApi.replaceNamespacedServiceAccount).toHaveBeenCalledTimes(1)
    expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(mockCoreApi.replaceNamespacedService).toHaveBeenCalledTimes(1)
    // Should NOT have created new resources
    expect(mockCoreApi.createNamespacedServiceAccount).not.toHaveBeenCalled()
    expect(mockAppsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(mockCoreApi.createNamespacedService).not.toHaveBeenCalled()
  })

  it("deploy() returns URL with custom port", async () => {
    resetMocks()
    const deployer = new McpServerDeployer()

    const result = await deployer.deploy(makeConfig({ port: 8080 }))

    expect(result.url).toBe("http://mcp-server-github.cortex-plane.svc:8080/mcp")
  })

  it("teardown() deletes all resources", async () => {
    resetMocks()
    const deployer = new McpServerDeployer()

    await deployer.teardown("github")

    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp-server-github", namespace: "cortex-plane" }) as Record<
        string,
        string
      >,
    )
    expect(mockCoreApi.deleteNamespacedService).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp-server-github", namespace: "cortex-plane" }) as Record<
        string,
        string
      >,
    )
    expect(mockCoreApi.deleteNamespacedServiceAccount).toHaveBeenCalledWith(
      expect.objectContaining({ name: "mcp-server-github", namespace: "cortex-plane" }) as Record<
        string,
        string
      >,
    )
  })

  it("teardown() with custom namespace", async () => {
    resetMocks()
    const deployer = new McpServerDeployer()

    await deployer.teardown("github", "custom-ns")

    expect(mockAppsApi.deleteNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "custom-ns" }) as Record<string, string>,
    )
  })

  it("teardown() ignores delete errors (best-effort)", async () => {
    resetMocks()
    mockAppsApi.deleteNamespacedDeployment.mockRejectedValue(new Error("not found"))
    mockCoreApi.deleteNamespacedService.mockRejectedValue(new Error("not found"))
    mockCoreApi.deleteNamespacedServiceAccount.mockRejectedValue(new Error("not found"))

    const deployer = new McpServerDeployer()
    // Should not throw
    await expect(deployer.teardown("github")).resolves.toBeUndefined()
  })

  it("waitForReady() resolves when deployment is ready", async () => {
    resetMocks()
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      status: { readyReplicas: 1 },
    })

    const deployer = new McpServerDeployer()
    await expect(deployer.waitForReady("github", 5000)).resolves.toBeUndefined()
  })

  it("waitForReady() throws on timeout", async () => {
    resetMocks()
    // Never becomes ready
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      status: { readyReplicas: 0 },
    })

    const deployer = new McpServerDeployer()
    await expect(deployer.waitForReady("github", 100)).rejects.toThrow(
      /did not become ready within 100ms/,
    )
  })

  it("getStatus() returns ready status", async () => {
    resetMocks()
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      status: { availableReplicas: 1, conditions: [] },
    })

    const deployer = new McpServerDeployer()
    const status = await deployer.getStatus("github")

    expect(status).toEqual({ ready: true, availableReplicas: 1, message: undefined })
  })

  it("getStatus() returns null when deployment not found", async () => {
    resetMocks()
    mockAppsApi.readNamespacedDeployment.mockRejectedValue(new Error("not found"))

    const deployer = new McpServerDeployer()
    const status = await deployer.getStatus("github")

    expect(status).toBeNull()
  })

  it("getStatus() includes failure message", async () => {
    resetMocks()
    mockAppsApi.readNamespacedDeployment.mockResolvedValue({
      status: {
        availableReplicas: 0,
        conditions: [
          {
            type: "Available",
            status: "False",
            message: "Deployment does not have minimum availability",
          },
        ],
      },
    })

    const deployer = new McpServerDeployer()
    const status = await deployer.getStatus("github")

    expect(status?.ready).toBe(false)
    expect(status?.message).toBe("Deployment does not have minimum availability")
  })
})
