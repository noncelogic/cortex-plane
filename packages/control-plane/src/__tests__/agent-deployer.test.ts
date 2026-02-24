import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  AgentDeployer,
  buildPod,
  buildRole,
  buildRoleBinding,
  buildServiceAccount,
} from "../k8s/agent-deployer.js"
import type { AgentDeploymentConfig } from "../k8s/types.js"

const baseConfig: AgentDeploymentConfig = {
  name: "devops-01",
  image: "noncelogic/cortex-agent:latest",
  resources: {
    requests: { cpu: "500m", memory: "512Mi" },
    limits: { cpu: "1000m", memory: "1Gi" },
  },
  env: { NODE_ENV: "production", AGENT_ID: "abc-123" },
  skills: ["git", "kubectl"],
}

// ---------------------------------------------------------------------------
// buildPod
// ---------------------------------------------------------------------------
describe("buildPod", () => {
  it("creates a pod with correct metadata", () => {
    const pod = buildPod(baseConfig)
    expect(pod.metadata?.name).toBe("agent-devops-01")
    expect(pod.metadata?.namespace).toBe("cortex-plane")
    expect(pod.metadata?.labels?.["app.kubernetes.io/component"]).toBe("agent")
    expect(pod.metadata?.labels?.["cortex.plane/agent-name"]).toBe("devops-01")
  })

  it("sets security context with non-root user", () => {
    const pod = buildPod(baseConfig)
    const sc = pod.spec?.securityContext
    expect(sc?.runAsNonRoot).toBe(true)
    expect(sc?.runAsUser).toBe(1000)
    expect(sc?.fsGroup).toBe(2000)
    expect(sc?.seccompProfile?.type).toBe("RuntimeDefault")
  })

  it("sets terminationGracePeriodSeconds to 65", () => {
    const pod = buildPod(baseConfig)
    expect(pod.spec?.terminationGracePeriodSeconds).toBe(65)
  })

  it("disables service account token mount", () => {
    const pod = buildPod(baseConfig)
    expect(pod.spec?.automountServiceAccountToken).toBe(false)
  })

  it("creates init container for hydration", () => {
    const pod = buildPod(baseConfig)
    expect(pod.spec?.initContainers).toHaveLength(1)
    expect(pod.spec?.initContainers?.[0]?.name).toBe("hydrate")
  })

  it("creates core-agent container with correct resources", () => {
    const pod = buildPod(baseConfig)
    const core = pod.spec?.containers.find((c) => c.name === "core-agent")
    expect(core).toBeDefined()
    expect(core?.resources?.requests?.cpu).toBe("500m")
    expect(core?.resources?.requests?.memory).toBe("512Mi")
    expect(core?.resources?.limits?.cpu).toBe("1000m")
    expect(core?.resources?.limits?.memory).toBe("1Gi")
  })

  it("core-agent has readOnlyRootFilesystem and drop ALL capabilities", () => {
    const pod = buildPod(baseConfig)
    const core = pod.spec?.containers.find((c) => c.name === "core-agent")
    expect(core?.securityContext?.readOnlyRootFilesystem).toBe(true)
    expect(core?.securityContext?.allowPrivilegeEscalation).toBe(false)
    expect(core?.securityContext?.capabilities?.drop).toEqual(["ALL"])
  })

  it("core-agent has liveness and readiness probes on /healthz port 4001", () => {
    const pod = buildPod(baseConfig)
    const core = pod.spec?.containers.find((c) => c.name === "core-agent")
    expect(core?.livenessProbe?.httpGet?.path).toBe("/healthz")
    expect(core?.livenessProbe?.httpGet?.port).toBe(4001)
    expect(core?.readinessProbe?.httpGet?.path).toBe("/healthz")
    expect(core?.readinessProbe?.httpGet?.port).toBe(4001)
  })

  it("core-agent mounts workspace with subPath per agent", () => {
    const pod = buildPod(baseConfig)
    const core = pod.spec?.containers.find((c) => c.name === "core-agent")
    const wsMount = core?.volumeMounts?.find((v) => v.name === "workspace")
    expect(wsMount?.mountPath).toBe("/workspace")
    expect(wsMount?.subPath).toBe("devops-01")
  })

  it("core-agent mounts tmp emptyDir", () => {
    const pod = buildPod(baseConfig)
    const core = pod.spec?.containers.find((c) => c.name === "core-agent")
    const tmpMount = core?.volumeMounts?.find((v) => v.name === "tmp")
    expect(tmpMount?.mountPath).toBe("/tmp")
  })

  it("injects env vars from config", () => {
    const pod = buildPod(baseConfig)
    const core = pod.spec?.containers.find((c) => c.name === "core-agent")
    const nodeEnv = core?.env?.find((e) => e.name === "NODE_ENV")
    expect(nodeEnv?.value).toBe("production")
    const agentId = core?.env?.find((e) => e.name === "AGENT_ID")
    expect(agentId?.value).toBe("abc-123")
  })

  it("does not include playwright sidecar by default", () => {
    const pod = buildPod(baseConfig)
    const pw = pod.spec?.containers.find((c) => c.name === "playwright")
    expect(pw).toBeUndefined()
    expect(pod.spec?.containers).toHaveLength(1)
  })

  it("includes playwright sidecar when playwrightEnabled", () => {
    const pod = buildPod({ ...baseConfig, playwrightEnabled: true })
    expect(pod.spec?.containers).toHaveLength(2)
    const pw = pod.spec?.containers.find((c) => c.name === "playwright")
    expect(pw).toBeDefined()
    expect(pw?.image).toBe("noncelogic/cortex-playwright-sidecar:latest")
    expect(pw?.ports?.[0]?.containerPort).toBe(9222)
    expect(pw?.command).toEqual(["node", "/opt/entrypoint.mjs"])
  })

  it("playwright sidecar has correct resources with 2Gi RAM cap", () => {
    const pod = buildPod({ ...baseConfig, playwrightEnabled: true })
    const pw = pod.spec?.containers.find((c) => c.name === "playwright")
    expect(pw?.resources?.requests?.cpu).toBe("500m")
    expect(pw?.resources?.requests?.memory).toBe("512Mi")
    expect(pw?.resources?.limits?.cpu).toBe("2000m")
    expect(pw?.resources?.limits?.memory).toBe("2Gi")
  })

  it("playwright sidecar has security context with capabilities dropped", () => {
    const pod = buildPod({ ...baseConfig, playwrightEnabled: true })
    const pw = pod.spec?.containers.find((c) => c.name === "playwright")
    expect(pw?.securityContext?.readOnlyRootFilesystem).toBe(false)
    expect(pw?.securityContext?.allowPrivilegeEscalation).toBe(false)
    expect(pw?.securityContext?.capabilities?.drop).toEqual(["ALL"])
  })

  it("playwright sidecar has readiness and startup probes on /json/version", () => {
    const pod = buildPod({ ...baseConfig, playwrightEnabled: true })
    const pw = pod.spec?.containers.find((c) => c.name === "playwright")
    expect(pw?.readinessProbe?.httpGet?.path).toBe("/json/version")
    expect(pw?.readinessProbe?.httpGet?.port).toBe(9222)
    expect(pw?.startupProbe?.httpGet?.path).toBe("/json/version")
    expect(pw?.startupProbe?.httpGet?.port).toBe(9222)
  })

  it("playwright sidecar has /dev/shm emptyDir mount", () => {
    const pod = buildPod({ ...baseConfig, playwrightEnabled: true })
    const pw = pod.spec?.containers.find((c) => c.name === "playwright")
    const shm = pw?.volumeMounts?.find((v) => v.name === "dshm")
    expect(shm?.mountPath).toBe("/dev/shm")
    const shmVol = pod.spec?.volumes?.find((v) => v.name === "dshm")
    expect(shmVol?.emptyDir?.medium).toBe("Memory")
  })

  it("playwright sidecar tmp volume has size limit", () => {
    const pod = buildPod({ ...baseConfig, playwrightEnabled: true })
    const tmpVol = pod.spec?.volumes?.find((v) => v.name === "tmp-playwright")
    expect(tmpVol?.emptyDir?.sizeLimit).toBe("500Mi")
  })

  it("uses custom namespace when provided", () => {
    const pod = buildPod({ ...baseConfig, namespace: "custom-ns" })
    expect(pod.metadata?.namespace).toBe("custom-ns")
  })
})

// ---------------------------------------------------------------------------
// buildServiceAccount
// ---------------------------------------------------------------------------
describe("buildServiceAccount", () => {
  it("creates SA with correct name and namespace", () => {
    const sa = buildServiceAccount("devops-01", "cortex-plane")
    expect(sa.metadata?.name).toBe("agent-devops-01")
    expect(sa.metadata?.namespace).toBe("cortex-plane")
  })

  it("disables token automount", () => {
    const sa = buildServiceAccount("devops-01", "cortex-plane")
    expect(sa.automountServiceAccountToken).toBe(false)
  })

  it("includes standard labels", () => {
    const sa = buildServiceAccount("devops-01", "cortex-plane")
    expect(sa.metadata?.labels?.["app.kubernetes.io/part-of"]).toBe("cortex-plane")
    expect(sa.metadata?.labels?.["cortex.plane/agent-name"]).toBe("devops-01")
  })
})

// ---------------------------------------------------------------------------
// buildRole
// ---------------------------------------------------------------------------
describe("buildRole", () => {
  it("creates role with get/watch on own configmap", () => {
    const role = buildRole("devops-01", "cortex-plane")
    const cmRule = role.rules?.find((r) => r.resources?.includes("configmaps"))
    expect(cmRule?.verbs).toEqual(["get", "watch"])
    expect(cmRule?.resourceNames).toEqual(["agent-devops-01-config"])
  })

  it("creates role with get on own secret", () => {
    const role = buildRole("devops-01", "cortex-plane")
    const secretRule = role.rules?.find((r) => r.resources?.includes("secrets"))
    expect(secretRule?.verbs).toEqual(["get"])
    expect(secretRule?.resourceNames).toEqual(["agent-devops-01-secrets"])
  })

  it("scopes rules to empty apiGroup (core)", () => {
    const role = buildRole("devops-01", "cortex-plane")
    for (const rule of role.rules ?? []) {
      expect(rule.apiGroups).toEqual([""])
    }
  })
})

// ---------------------------------------------------------------------------
// buildRoleBinding
// ---------------------------------------------------------------------------
describe("buildRoleBinding", () => {
  it("binds to the correct role", () => {
    const rb = buildRoleBinding("devops-01", "cortex-plane")
    expect(rb.roleRef.name).toBe("agent-devops-01")
    expect(rb.roleRef.kind).toBe("Role")
  })

  it("references the correct service account", () => {
    const rb = buildRoleBinding("devops-01", "cortex-plane")
    expect(rb.subjects?.[0]?.name).toBe("agent-devops-01")
    expect(rb.subjects?.[0]?.kind).toBe("ServiceAccount")
  })
})

// ---------------------------------------------------------------------------
// AgentDeployer (mocked k8s client)
// ---------------------------------------------------------------------------
describe("AgentDeployer", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockCoreApi: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRbacApi: any
  let deployer: AgentDeployer

  beforeEach(() => {
    mockCoreApi = {
      readNamespacedServiceAccount: vi.fn(),
      replaceNamespacedServiceAccount: vi.fn(),
      createNamespacedServiceAccount: vi.fn(),
      deleteNamespacedServiceAccount: vi.fn(),
      createNamespacedPod: vi.fn(),
      deleteNamespacedPod: vi.fn(),
      readNamespacedPod: vi.fn(),
      listNamespacedPod: vi.fn(),
    }

    mockRbacApi = {
      readNamespacedRole: vi.fn(),
      replaceNamespacedRole: vi.fn(),
      createNamespacedRole: vi.fn(),
      readNamespacedRoleBinding: vi.fn(),
      replaceNamespacedRoleBinding: vi.fn(),
      createNamespacedRoleBinding: vi.fn(),
      deleteNamespacedRole: vi.fn(),
      deleteNamespacedRoleBinding: vi.fn(),
    }

    // Build deployer with mocked API clients
    const kc = {
      makeApiClient: vi.fn((apiClass: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const k8s = require("@kubernetes/client-node")
        if (apiClass === k8s.CoreV1Api) return mockCoreApi
        if (apiClass === k8s.RbacAuthorizationV1Api) return mockRbacApi
        return {}
      }),
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    deployer = new AgentDeployer(kc as any, "cortex-plane")
  })

  describe("deployAgent", () => {
    it("creates new resources when they do not exist", async () => {
      mockCoreApi.readNamespacedServiceAccount.mockRejectedValue(new Error("not found"))
      mockRbacApi.readNamespacedRole.mockRejectedValue(new Error("not found"))
      mockRbacApi.readNamespacedRoleBinding.mockRejectedValue(new Error("not found"))
      mockCoreApi.deleteNamespacedPod.mockRejectedValue(new Error("not found"))
      mockCoreApi.createNamespacedServiceAccount.mockResolvedValue({})
      mockRbacApi.createNamespacedRole.mockResolvedValue({})
      mockRbacApi.createNamespacedRoleBinding.mockResolvedValue({})
      mockCoreApi.createNamespacedPod.mockResolvedValue({})

      await deployer.deployAgent(baseConfig)

      expect(mockCoreApi.createNamespacedServiceAccount).toHaveBeenCalledOnce()
      expect(mockRbacApi.createNamespacedRole).toHaveBeenCalledOnce()
      expect(mockRbacApi.createNamespacedRoleBinding).toHaveBeenCalledOnce()
      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalledOnce()
    })

    it("updates existing resources when they exist", async () => {
      mockCoreApi.readNamespacedServiceAccount.mockResolvedValue({})
      mockRbacApi.readNamespacedRole.mockResolvedValue({})
      mockRbacApi.readNamespacedRoleBinding.mockResolvedValue({})
      mockCoreApi.replaceNamespacedServiceAccount.mockResolvedValue({})
      mockRbacApi.replaceNamespacedRole.mockResolvedValue({})
      mockRbacApi.replaceNamespacedRoleBinding.mockResolvedValue({})
      mockCoreApi.deleteNamespacedPod.mockResolvedValue({})
      mockCoreApi.createNamespacedPod.mockResolvedValue({})

      await deployer.deployAgent(baseConfig)

      expect(mockCoreApi.replaceNamespacedServiceAccount).toHaveBeenCalledOnce()
      expect(mockRbacApi.replaceNamespacedRole).toHaveBeenCalledOnce()
      expect(mockRbacApi.replaceNamespacedRoleBinding).toHaveBeenCalledOnce()
      expect(mockCoreApi.createNamespacedPod).toHaveBeenCalledOnce()
    })
  })

  describe("deleteAgent", () => {
    it("deletes all agent resources", async () => {
      mockCoreApi.deleteNamespacedPod.mockResolvedValue({})
      mockRbacApi.deleteNamespacedRoleBinding.mockResolvedValue({})
      mockRbacApi.deleteNamespacedRole.mockResolvedValue({})
      mockCoreApi.deleteNamespacedServiceAccount.mockResolvedValue({})

      await deployer.deleteAgent("devops-01")

      expect(mockCoreApi.deleteNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({ name: "agent-devops-01" }),
      )
      expect(mockRbacApi.deleteNamespacedRoleBinding).toHaveBeenCalledWith(
        expect.objectContaining({ name: "agent-devops-01" }),
      )
      expect(mockRbacApi.deleteNamespacedRole).toHaveBeenCalledWith(
        expect.objectContaining({ name: "agent-devops-01" }),
      )
    })

    it("ignores errors for already-deleted resources", async () => {
      mockCoreApi.deleteNamespacedPod.mockRejectedValue(new Error("not found"))
      mockRbacApi.deleteNamespacedRoleBinding.mockRejectedValue(new Error("not found"))
      mockRbacApi.deleteNamespacedRole.mockRejectedValue(new Error("not found"))
      mockCoreApi.deleteNamespacedServiceAccount.mockRejectedValue(new Error("not found"))

      await expect(deployer.deleteAgent("devops-01")).resolves.toBeUndefined()
    })
  })

  describe("getAgentStatus", () => {
    it("returns pod status when pod exists", async () => {
      mockCoreApi.readNamespacedPod.mockResolvedValue({
        metadata: { name: "agent-devops-01" },
        status: {
          phase: "Running",
          startTime: new Date("2026-01-01T00:00:00Z"),
          containerStatuses: [
            {
              name: "core-agent",
              ready: true,
              restartCount: 0,
              state: { running: { startedAt: new Date() } },
            },
          ],
        },
      })

      const status = await deployer.getAgentStatus("devops-01")
      expect(status).not.toBeNull()
      expect(status?.name).toBe("agent-devops-01")
      expect(status?.phase).toBe("Running")
      expect(status?.containerStatuses).toHaveLength(1)
      expect(status?.containerStatuses[0]?.state).toBe("running")
    })

    it("returns null when pod does not exist", async () => {
      mockCoreApi.readNamespacedPod.mockRejectedValue(new Error("not found"))
      const status = await deployer.getAgentStatus("nonexistent")
      expect(status).toBeNull()
    })
  })

  describe("listAgents", () => {
    it("returns all agent pods", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({
        items: [
          {
            metadata: { name: "agent-devops-01" },
            status: { phase: "Running", containerStatuses: [] },
          },
          {
            metadata: { name: "agent-frontend-01" },
            status: { phase: "Pending", containerStatuses: [] },
          },
        ],
      })

      const agents = await deployer.listAgents()
      expect(agents).toHaveLength(2)
      expect(agents[0]?.name).toBe("agent-devops-01")
      expect(agents[1]?.name).toBe("agent-frontend-01")
    })

    it("uses correct label selector", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] })

      await deployer.listAgents()

      expect(mockCoreApi.listNamespacedPod).toHaveBeenCalledWith(
        expect.objectContaining({
          labelSelector: "app.kubernetes.io/component=agent",
        }),
      )
    })

    it("returns empty array when no agents exist", async () => {
      mockCoreApi.listNamespacedPod.mockResolvedValue({ items: [] })
      const agents = await deployer.listAgents()
      expect(agents).toEqual([])
    })
  })
})
