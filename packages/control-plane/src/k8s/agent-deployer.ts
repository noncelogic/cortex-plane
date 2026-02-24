import * as k8s from "@kubernetes/client-node"

import type { AgentDeploymentConfig, AgentPodStatus, ContainerStatus } from "./types.js"

const DEFAULT_NAMESPACE = "cortex-plane"

const LABELS = {
  app: "cortex-agent",
  "app.kubernetes.io/name": "cortex-agent",
  "app.kubernetes.io/component": "agent",
  "app.kubernetes.io/part-of": "cortex-plane",
} as const

function agentLabels(name: string): Record<string, string> {
  return {
    ...LABELS,
    "cortex.plane/agent-name": name,
  }
}

function buildPod(config: AgentDeploymentConfig): k8s.V1Pod {
  const ns = config.namespace ?? DEFAULT_NAMESPACE
  const labels = agentLabels(config.name)

  const envVars: k8s.V1EnvVar[] = Object.entries(config.env).map(([name, value]) => ({
    name,
    value,
  }))

  const containers: k8s.V1Container[] = [
    {
      name: "core-agent",
      image: config.image,
      ports: [{ containerPort: 4001, name: "health", protocol: "TCP" }],
      resources: {
        requests: { cpu: config.resources.requests.cpu, memory: config.resources.requests.memory },
        limits: { cpu: config.resources.limits.cpu, memory: config.resources.limits.memory },
      },
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
      livenessProbe: {
        httpGet: { path: "/healthz", port: 4001 },
        initialDelaySeconds: 10,
        periodSeconds: 15,
        timeoutSeconds: 3,
        failureThreshold: 3,
      },
      readinessProbe: {
        httpGet: { path: "/healthz", port: 4001 },
        initialDelaySeconds: 5,
        periodSeconds: 5,
        timeoutSeconds: 3,
        failureThreshold: 3,
      },
      env: envVars,
      volumeMounts: [
        { name: "workspace", mountPath: "/workspace", subPath: config.name },
        { name: "tmp", mountPath: "/tmp" },
      ],
    },
  ]

  const volumes: k8s.V1Volume[] = [
    {
      name: "workspace",
      persistentVolumeClaim: { claimName: "agent-workspace" },
    },
    {
      name: "tmp",
      emptyDir: {},
    },
  ]

  if (config.playwrightEnabled) {
    containers.push({
      name: "playwright",
      image: "mcr.microsoft.com/playwright:latest",
      ports: [{ containerPort: 9222, name: "cdp", protocol: "TCP" }],
      resources: {
        requests: { cpu: "1000m", memory: "1Gi" },
        limits: { cpu: "2000m", memory: "2Gi" },
      },
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
      volumeMounts: [
        { name: "workspace", mountPath: "/workspace", subPath: config.name },
        { name: "dshm", mountPath: "/dev/shm" },
        { name: "tmp-playwright", mountPath: "/tmp" },
      ],
    })

    volumes.push(
      { name: "dshm", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
      { name: "tmp-playwright", emptyDir: {} },
    )
  }

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `agent-${config.name}`,
      namespace: ns,
      labels,
    },
    spec: {
      serviceAccountName: `agent-${config.name}`,
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 65,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        fsGroup: 2000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      initContainers: [
        {
          name: "hydrate",
          image: config.image,
          command: ["/bin/sh", "-c", "echo hydrate"],
          resources: {
            requests: { cpu: "100m", memory: "64Mi" },
            limits: { cpu: "200m", memory: "128Mi" },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace", subPath: config.name },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      containers,
      volumes,
    },
  }
}

function buildServiceAccount(name: string, namespace: string): k8s.V1ServiceAccount {
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: `agent-${name}`,
      namespace,
      labels: agentLabels(name),
    },
    automountServiceAccountToken: false,
  }
}

function buildRole(name: string, namespace: string): k8s.V1Role {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "Role",
    metadata: {
      name: `agent-${name}`,
      namespace,
      labels: agentLabels(name),
    },
    rules: [
      {
        apiGroups: [""],
        resources: ["configmaps"],
        resourceNames: [`agent-${name}-config`],
        verbs: ["get", "watch"],
      },
      {
        apiGroups: [""],
        resources: ["secrets"],
        resourceNames: [`agent-${name}-secrets`],
        verbs: ["get"],
      },
    ],
  }
}

function buildRoleBinding(name: string, namespace: string): k8s.V1RoleBinding {
  return {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: {
      name: `agent-${name}`,
      namespace,
      labels: agentLabels(name),
    },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: `agent-${name}`,
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: `agent-${name}`,
        namespace,
      },
    ],
  }
}

export class AgentDeployer {
  private coreApi: k8s.CoreV1Api
  private rbacApi: k8s.RbacAuthorizationV1Api
  private defaultNamespace: string

  constructor(kubeConfig?: k8s.KubeConfig, namespace?: string) {
    const kc = kubeConfig ?? new k8s.KubeConfig()
    if (!kubeConfig) {
      kc.loadFromDefault()
    }
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api)
    this.rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api)
    this.defaultNamespace = namespace ?? DEFAULT_NAMESPACE
  }

  async deployAgent(config: AgentDeploymentConfig): Promise<void> {
    const ns = config.namespace ?? this.defaultNamespace

    const sa = buildServiceAccount(config.name, ns)
    const role = buildRole(config.name, ns)
    const rb = buildRoleBinding(config.name, ns)
    const pod = buildPod(config)

    // Create or update SA
    try {
      await this.coreApi.readNamespacedServiceAccount({
        name: `agent-${config.name}`,
        namespace: ns,
      })
      await this.coreApi.replaceNamespacedServiceAccount({
        name: `agent-${config.name}`,
        namespace: ns,
        body: sa,
      })
    } catch {
      await this.coreApi.createNamespacedServiceAccount({ namespace: ns, body: sa })
    }

    // Create or update Role
    try {
      await this.rbacApi.readNamespacedRole({ name: `agent-${config.name}`, namespace: ns })
      await this.rbacApi.replaceNamespacedRole({
        name: `agent-${config.name}`,
        namespace: ns,
        body: role,
      })
    } catch {
      await this.rbacApi.createNamespacedRole({ namespace: ns, body: role })
    }

    // Create or update RoleBinding
    try {
      await this.rbacApi.readNamespacedRoleBinding({ name: `agent-${config.name}`, namespace: ns })
      await this.rbacApi.replaceNamespacedRoleBinding({
        name: `agent-${config.name}`,
        namespace: ns,
        body: rb,
      })
    } catch {
      await this.rbacApi.createNamespacedRoleBinding({ namespace: ns, body: rb })
    }

    // Create or replace Pod (delete + create since pods are immutable)
    try {
      await this.coreApi.deleteNamespacedPod({
        name: `agent-${config.name}`,
        namespace: ns,
      })
    } catch {
      // Pod may not exist — that's fine
    }
    await this.coreApi.createNamespacedPod({ namespace: ns, body: pod })
  }

  async deleteAgent(agentName: string, namespace?: string): Promise<void> {
    const ns = namespace ?? this.defaultNamespace

    const deletions = [
      this.coreApi
        .deleteNamespacedPod({ name: `agent-${agentName}`, namespace: ns })
        .catch(() => {}),
      this.rbacApi
        .deleteNamespacedRoleBinding({ name: `agent-${agentName}`, namespace: ns })
        .catch(() => {}),
      this.rbacApi
        .deleteNamespacedRole({ name: `agent-${agentName}`, namespace: ns })
        .catch(() => {}),
      this.coreApi
        .deleteNamespacedServiceAccount({ name: `agent-${agentName}`, namespace: ns })
        .catch(() => {}),
    ]

    await Promise.all(deletions)
  }

  async getAgentStatus(agentName: string, namespace?: string): Promise<AgentPodStatus | null> {
    const ns = namespace ?? this.defaultNamespace

    try {
      const response = await this.coreApi.readNamespacedPod({
        name: `agent-${agentName}`,
        namespace: ns,
      })
      const pod = response
      return parsePodStatus(pod)
    } catch {
      return null
    }
  }

  async listAgents(namespace?: string): Promise<AgentPodStatus[]> {
    const ns = namespace ?? this.defaultNamespace

    const response = await this.coreApi.listNamespacedPod({
      namespace: ns,
      labelSelector: "app.kubernetes.io/component=agent",
    })
    return response.items.map(parsePodStatus)
  }
}

function parsePodStatus(pod: k8s.V1Pod): AgentPodStatus {
  const containerStatuses: ContainerStatus[] =
    pod.status?.containerStatuses?.map((cs) => {
      let state = "unknown"
      if (cs.state?.running) state = "running"
      else if (cs.state?.waiting) state = `waiting: ${cs.state.waiting.reason ?? "unknown"}`
      else if (cs.state?.terminated) state = `terminated: ${cs.state.terminated.reason ?? "unknown"}`

      return {
        name: cs.name,
        ready: cs.ready,
        restartCount: cs.restartCount,
        state,
      }
    }) ?? []

  return {
    name: pod.metadata?.name ?? "unknown",
    phase: pod.status?.phase,
    containerStatuses,
    startTime: pod.status?.startTime,
  }
}

export { buildPod, buildRole, buildRoleBinding, buildServiceAccount }
