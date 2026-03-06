export interface AgentResources {
  cpu: string
  memory: string
}

export interface AgentResourceSpec {
  requests: AgentResources
  limits: AgentResources
}

export interface McpSidecarSpec {
  slug: string
  image: string
  command: string[]
  env?: Record<string, string>
  resources?: AgentResourceSpec
}

export interface AgentDeploymentConfig {
  name: string
  image: string
  resources: AgentResourceSpec
  env: Record<string, string>
  skills: string[]
  playwrightEnabled?: boolean
  mcpSidecars?: McpSidecarSpec[]
  namespace?: string
}

export interface AgentPodStatus {
  name: string
  phase: string | undefined
  containerStatuses: ContainerStatus[]
  startTime: Date | undefined
}

export interface ContainerStatus {
  name: string
  ready: boolean
  restartCount: number
  state: string
}
