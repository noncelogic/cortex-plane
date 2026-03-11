/**
 * MCP Server Kubernetes Deployer
 *
 * Creates Deployment + Service + ServiceAccount for in-cluster MCP servers.
 * Triggered when an operator registers a server with `connection.image`.
 */

import * as k8s from "@kubernetes/client-node"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerDeploymentConfig {
  /** MCP server slug — used as resource name suffix */
  slug: string
  /** Container image to run */
  image: string
  /** Container port (default 3000) */
  port?: number
  /** Resource requests/limits */
  resources?: {
    cpu?: string
    memory?: string
  }
  /** Environment variables for the container */
  env?: Record<string, string>
  /** Kubernetes namespace (default cortex-plane) */
  namespace?: string
}

export interface McpDeploymentResult {
  /** In-cluster service URL: http://<svc>.<ns>.svc:<port>/mcp */
  url: string
  /** Name of the created Deployment */
  deploymentName: string
  /** Name of the created Service */
  serviceName: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_NAMESPACE = "cortex-plane"
const DEFAULT_PORT = 3000
const DEFAULT_CPU = "100m"
const DEFAULT_MEMORY = "128Mi"
const READINESS_POLL_MS = 2000

const LABELS_BASE = {
  "app.kubernetes.io/managed-by": "cortex-plane",
  "app.kubernetes.io/component": "mcp-server",
  "app.kubernetes.io/part-of": "cortex-plane",
} as const

function mcpLabels(slug: string): Record<string, string> {
  return {
    ...LABELS_BASE,
    "cortex.io/mcp-server": slug,
  }
}

// ---------------------------------------------------------------------------
// Resource builders (exported for testing)
// ---------------------------------------------------------------------------

export function buildDeployment(config: McpServerDeploymentConfig): k8s.V1Deployment {
  const ns = config.namespace ?? DEFAULT_NAMESPACE
  const port = config.port ?? DEFAULT_PORT
  const cpu = config.resources?.cpu ?? DEFAULT_CPU
  const memory = config.resources?.memory ?? DEFAULT_MEMORY
  const labels = mcpLabels(config.slug)
  const name = `mcp-server-${config.slug}`

  const envVars: k8s.V1EnvVar[] = config.env
    ? Object.entries(config.env).map(([k, v]) => ({ name: k, value: v }))
    : []

  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace: ns,
      labels,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: { "cortex.io/mcp-server": config.slug },
      },
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: name,
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 30,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            fsGroup: 2000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "mcp-server",
              image: config.image,
              ports: [{ containerPort: port, name: "http", protocol: "TCP" }],
              env: envVars,
              resources: {
                requests: { cpu, memory },
                limits: { cpu, memory },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              livenessProbe: {
                httpGet: { path: "/mcp", port },
                initialDelaySeconds: 10,
                periodSeconds: 15,
                timeoutSeconds: 3,
                failureThreshold: 3,
              },
              readinessProbe: {
                httpGet: { path: "/mcp", port },
                initialDelaySeconds: 3,
                periodSeconds: 5,
                timeoutSeconds: 3,
                failureThreshold: 3,
              },
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: { sizeLimit: "128Mi" } }],
        },
      },
    },
  }
}

export function buildService(config: McpServerDeploymentConfig): k8s.V1Service {
  const ns = config.namespace ?? DEFAULT_NAMESPACE
  const port = config.port ?? DEFAULT_PORT
  const name = `mcp-server-${config.slug}`

  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name,
      namespace: ns,
      labels: mcpLabels(config.slug),
    },
    spec: {
      type: "ClusterIP",
      selector: { "cortex.io/mcp-server": config.slug },
      ports: [{ name: "http", port, targetPort: port, protocol: "TCP" }],
    },
  }
}

export function buildServiceAccount(config: McpServerDeploymentConfig): k8s.V1ServiceAccount {
  const ns = config.namespace ?? DEFAULT_NAMESPACE
  const name = `mcp-server-${config.slug}`

  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name,
      namespace: ns,
      labels: mcpLabels(config.slug),
    },
    automountServiceAccountToken: false,
  }
}

// ---------------------------------------------------------------------------
// Deployer class
// ---------------------------------------------------------------------------

export class McpServerDeployer {
  private appsApi: k8s.AppsV1Api
  private coreApi: k8s.CoreV1Api
  private defaultNamespace: string

  constructor(kubeConfig?: k8s.KubeConfig, namespace?: string) {
    const kc = kubeConfig ?? new k8s.KubeConfig()
    if (!kubeConfig) {
      kc.loadFromDefault()
    }
    this.appsApi = kc.makeApiClient(k8s.AppsV1Api)
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api)
    this.defaultNamespace = namespace ?? DEFAULT_NAMESPACE
  }

  /**
   * Deploy an MCP server as a Deployment + Service + ServiceAccount.
   * Returns the in-cluster service URL on success.
   */
  async deploy(config: McpServerDeploymentConfig): Promise<McpDeploymentResult> {
    const ns = config.namespace ?? this.defaultNamespace
    const port = config.port ?? DEFAULT_PORT
    const name = `mcp-server-${config.slug}`
    const resolvedConfig = { ...config, namespace: ns }

    // 1. ServiceAccount (create-or-update)
    const sa = buildServiceAccount(resolvedConfig)
    try {
      await this.coreApi.readNamespacedServiceAccount({ name, namespace: ns })
      await this.coreApi.replaceNamespacedServiceAccount({ name, namespace: ns, body: sa })
    } catch {
      await this.coreApi.createNamespacedServiceAccount({ namespace: ns, body: sa })
    }

    // 2. Deployment (create-or-update)
    const deployment = buildDeployment(resolvedConfig)
    try {
      await this.appsApi.readNamespacedDeployment({ name, namespace: ns })
      await this.appsApi.replaceNamespacedDeployment({ name, namespace: ns, body: deployment })
    } catch {
      await this.appsApi.createNamespacedDeployment({ namespace: ns, body: deployment })
    }

    // 3. Service (create-or-update)
    const service = buildService(resolvedConfig)
    try {
      await this.coreApi.readNamespacedService({ name, namespace: ns })
      await this.coreApi.replaceNamespacedService({ name, namespace: ns, body: service })
    } catch {
      await this.coreApi.createNamespacedService({ namespace: ns, body: service })
    }

    const url = `http://${name}.${ns}.svc:${port}/mcp`
    return { url, deploymentName: name, serviceName: name }
  }

  /**
   * Wait for the deployment to have at least one ready replica.
   * Throws on timeout.
   */
  async waitForReady(slug: string, timeoutMs = 120_000): Promise<void> {
    const ns = this.defaultNamespace
    const name = `mcp-server-${slug}`
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      try {
        const deployment = await this.appsApi.readNamespacedDeployment({ name, namespace: ns })
        const readyReplicas = deployment.status?.readyReplicas ?? 0
        if (readyReplicas > 0) {
          return
        }
      } catch {
        // Deployment may not exist yet — keep polling
      }

      await sleep(READINESS_POLL_MS)
    }

    throw new Error(`MCP server deployment '${name}' did not become ready within ${timeoutMs}ms`)
  }

  /**
   * Tear down all k8s resources for an MCP server.
   */
  async teardown(slug: string, namespace?: string): Promise<void> {
    const ns = namespace ?? this.defaultNamespace
    const name = `mcp-server-${slug}`

    const ignoreDeletionError = (resource: string) => (err: unknown) => {
      console.debug(
        `[k8s-deployer] ignoring cleanup error for ${resource} '${name}' in '${ns}':`,
        err,
      )
    }

    await Promise.all([
      this.appsApi
        .deleteNamespacedDeployment({ name, namespace: ns })
        .catch(ignoreDeletionError("Deployment")),
      this.coreApi
        .deleteNamespacedService({ name, namespace: ns })
        .catch(ignoreDeletionError("Service")),
      this.coreApi
        .deleteNamespacedServiceAccount({ name, namespace: ns })
        .catch(ignoreDeletionError("ServiceAccount")),
    ])
  }

  /**
   * Get the status of an MCP server deployment.
   */
  async getStatus(
    slug: string,
    namespace?: string,
  ): Promise<{ ready: boolean; availableReplicas: number; message?: string } | null> {
    const ns = namespace ?? this.defaultNamespace
    const name = `mcp-server-${slug}`

    try {
      const deployment = await this.appsApi.readNamespacedDeployment({ name, namespace: ns })
      const available = deployment.status?.availableReplicas ?? 0
      const ready = available > 0

      // Check for failure conditions
      const conditions = deployment.status?.conditions ?? []
      const failedCondition = conditions.find((c) => c.type === "Available" && c.status === "False")

      return {
        ready,
        availableReplicas: available,
        message: failedCondition?.message,
      }
    } catch {
      return null
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
