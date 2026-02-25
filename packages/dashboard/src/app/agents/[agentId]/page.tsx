"use client"

import { use, useCallback, useMemo, useState } from "react"

import { AgentConsole } from "@/components/agents/agent-console"
import { AgentHeader } from "@/components/agents/agent-header"
import { type LifecycleStep, LifecycleTimeline } from "@/components/agents/lifecycle-timeline"
import { ResourceSparklines } from "@/components/agents/resource-sparklines"
import { SteerInput } from "@/components/agents/steer-input"
import { Skeleton } from "@/components/layout/skeleton"
import { type AgentEventPayload, useAgentStream } from "@/hooks/use-agent-stream"
import { useApiQuery } from "@/hooks/use-api"
import { type AgentDetail, type AgentLifecycleState, getAgent, pauseAgent } from "@/lib/api-client"

// ---------------------------------------------------------------------------
// Mobile tabs
// ---------------------------------------------------------------------------

const MOBILE_TABS = ["Output", "Details", "Browser", "Memory"] as const
type MobileTab = (typeof MOBILE_TABS)[number]

// ---------------------------------------------------------------------------
// Resource mock helpers (will be replaced by real telemetry SSE)
// ---------------------------------------------------------------------------

function buildMetrics(events: AgentEventPayload[]) {
  // Extract resource-like data from output events for sparklines
  // In production this will come from a dedicated metrics SSE channel
  const cpuSamples: number[] = []
  const memSamples: number[] = []
  const networkSamples: number[] = []
  const tokenSamples: number[] = []

  for (const event of events) {
    if (event.type === "agent:output") {
      const output = event.data.output
      if (typeof output.cpuPercent === "number") cpuSamples.push(output.cpuPercent)
      if (typeof output.memPercent === "number") memSamples.push(output.memPercent)
      if (typeof output.networkKbps === "number") networkSamples.push(output.networkKbps)
      if (typeof output.tokensPerSec === "number") tokenSamples.push(output.tokensPerSec)
    }
  }

  const last = (arr: number[]) => arr[arr.length - 1] ?? 0

  return [
    {
      label: "CPU",
      value: String(Math.round(last(cpuSamples))),
      unit: "%",
      delta:
        cpuSamples.length > 1
          ? `${last(cpuSamples) > cpuSamples[cpuSamples.length - 2]! ? "+" : ""}${Math.round(last(cpuSamples) - cpuSamples[cpuSamples.length - 2]!)}%`
          : undefined,
      deltaType: "neutral" as const,
      samples: cpuSamples,
      icon: "memory",
    },
    {
      label: "Memory",
      value: String(Math.round(last(memSamples))),
      unit: "%",
      delta: undefined,
      deltaType: "neutral" as const,
      samples: memSamples,
      icon: "data_usage",
    },
    {
      label: "Network",
      value: String(Math.round(last(networkSamples))),
      unit: "kb/s",
      delta: undefined,
      deltaType: "neutral" as const,
      samples: networkSamples,
      icon: "speed",
    },
    {
      label: "Tokens/sec",
      value: String(Math.round(last(tokenSamples))),
      unit: "t/s",
      delta: undefined,
      deltaType: "positive" as const,
      samples: tokenSamples,
      icon: "hub",
    },
  ]
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

interface Props {
  params: Promise<{ agentId: string }>
}

export default function AgentDetailPage({ params }: Props): React.JSX.Element {
  const { agentId } = use(params)
  const { data: agent, isLoading } = useApiQuery(() => getAgent(agentId), [agentId])
  const { events } = useAgentStream(agentId)
  const [mobileTab, setMobileTab] = useState<MobileTab>("Output")

  // Build lifecycle transitions from state events
  const transitions = useMemo<LifecycleStep[]>(() => {
    return events
      .filter(
        (e): e is Extract<AgentEventPayload, { type: "agent:state" }> => e.type === "agent:state",
      )
      .map((e) => ({ state: e.data.state as AgentLifecycleState, timestamp: e.data.timestamp }))
  }, [events])

  // Current lifecycle state
  const currentState: AgentLifecycleState = useMemo(() => {
    const lastState = transitions[transitions.length - 1]
    return lastState?.state ?? agent?.lifecycleState ?? "BOOTING"
  }, [transitions, agent])

  // Resource metrics from events
  const metrics = useMemo(() => buildMetrics(events), [events])

  const handlePause = useCallback(async () => {
    try {
      await pauseAgent(agentId)
    } catch {
      // handled by UI
    }
  }, [agentId])

  if (isLoading || !agent) {
    return <LoadingSkeleton />
  }

  // Build agent with possibly-updated lifecycle state
  const liveAgent: AgentDetail = { ...agent, lifecycleState: currentState }

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
      {/* Header */}
      <AgentHeader agent={liveAgent} onPause={() => void handlePause()} />

      {/* Lifecycle timeline (desktop only) */}
      <LifecycleTimeline currentState={currentState} transitions={transitions} />

      {/* Mobile tabs */}
      <div className="sticky top-0 z-40 -mx-4 border-b border-surface-border bg-bg-dark/50 backdrop-blur lg:hidden">
        <div className="flex">
          {MOBILE_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setMobileTab(tab)}
              className={`flex-1 py-4 text-sm font-medium transition-colors ${
                mobileTab === tab
                  ? "border-b-2 border-primary text-primary"
                  : "border-b-2 border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Desktop: 3-column layout */}
      <div className="hidden flex-1 gap-6 lg:flex">
        {/* Left column: steering + lifecycle details */}
        <div className="flex w-80 shrink-0 flex-col gap-6">
          <SteerInput agentId={agentId} />
          <LifecycleDetails transitions={transitions} currentState={currentState} />
        </div>

        {/* Center: console */}
        <div className="flex min-w-0 flex-1 flex-col">
          <AgentConsole agentId={agentId} />
        </div>

        {/* Right column: resources */}
        <div className="flex w-72 shrink-0 flex-col gap-6">
          <ResourcePanel metrics={metrics} />
        </div>
      </div>

      {/* Mobile: tab content */}
      <div className="flex flex-1 flex-col pb-24 lg:hidden">
        {mobileTab === "Output" && (
          <div className="flex flex-1 flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              {metrics.slice(0, 4).map((m) => (
                <MobileKpiCard
                  key={m.label}
                  label={m.label}
                  value={m.value}
                  unit={m.unit}
                  icon={m.icon}
                />
              ))}
            </div>
            <AgentConsole agentId={agentId} />
          </div>
        )}
        {mobileTab === "Details" && (
          <div className="flex flex-col gap-4">
            <SteerInput agentId={agentId} />
            <LifecycleDetails transitions={transitions} currentState={currentState} />
          </div>
        )}
        {mobileTab === "Browser" && (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-surface-border bg-surface-dark p-8">
            <div className="text-center">
              <span className="material-symbols-outlined mb-2 text-3xl text-slate-600">web</span>
              <p className="text-sm text-slate-500">Browser view coming soon</p>
            </div>
          </div>
        )}
        {mobileTab === "Memory" && (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-surface-border bg-surface-dark p-8">
            <div className="text-center">
              <span className="material-symbols-outlined mb-2 text-3xl text-slate-600">memory</span>
              <p className="text-sm text-slate-500">Memory view coming soon</p>
            </div>
          </div>
        )}
      </div>

      {/* Mobile steering input (fixed bottom) */}
      <MobileSteerBar agentId={agentId} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LoadingSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-6 p-4 lg:p-6">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="hidden h-20 w-full lg:block" />
      <div className="hidden flex-1 gap-6 lg:flex">
        <Skeleton className="h-96 w-80" />
        <Skeleton className="h-96 flex-1" />
        <Skeleton className="h-96 w-72" />
      </div>
    </div>
  )
}

function LifecycleDetails({
  transitions,
  currentState,
}: {
  transitions: LifecycleStep[]
  currentState: AgentLifecycleState
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-primary/10 dark:bg-primary/5">
      <div className="mb-4 flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">timeline</span>
        <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
          State Timeline
        </h3>
      </div>

      {transitions.length === 0 ? (
        <p className="text-sm text-slate-500">No transitions recorded yet.</p>
      ) : (
        <div className="space-y-3">
          {transitions.map((t, i) => {
            const isCurrent = t.state === currentState && i === transitions.length - 1
            return (
              <div key={i} className="flex items-start gap-3">
                <div className="flex flex-col items-center">
                  <div
                    className={`size-3 rounded-full ${
                      isCurrent
                        ? "bg-primary ring-4 ring-primary/20"
                        : "bg-slate-300 dark:bg-slate-600"
                    }`}
                  />
                  {i < transitions.length - 1 && (
                    <div className="mt-1 h-6 w-px bg-slate-200 dark:bg-primary/20" />
                  )}
                </div>
                <div className="-mt-0.5">
                  <span
                    className={`text-xs font-bold uppercase tracking-wider ${
                      isCurrent ? "text-primary" : "text-slate-500"
                    }`}
                  >
                    {t.state}
                  </span>
                  {t.timestamp && (
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {new Date(t.timestamp).toLocaleTimeString("en-US", {
                        hour12: false,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ResourcePanel({
  metrics,
}: {
  metrics: ReturnType<typeof buildMetrics>
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-primary">monitoring</span>
        <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">
          Resource Metrics
        </h3>
      </div>
      <ResourceSparklines metrics={metrics} />
    </div>
  )
}

function MobileKpiCard({
  label,
  value,
  unit,
  icon,
}: {
  label: string
  value: string
  unit: string
  icon: string
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-dark p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[14px] text-slate-400">{icon}</span>
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-lg font-bold text-white">{value}</span>
        <span className="text-xs text-slate-400">{unit}</span>
      </div>
    </div>
  )
}

function MobileSteerBar({ agentId }: { agentId: string }): React.JSX.Element {
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)

  const handleSend = useCallback(async () => {
    if (!message.trim() || sending) return
    setSending(true)
    try {
      const { steerAgent: steer } = await import("@/lib/api-client")
      await steer(agentId, { message: message.trim() })
      setMessage("")
    } catch {
      // handled silently on mobile
    } finally {
      setSending(false)
    }
  }, [agentId, message, sending])

  return (
    <div className="fixed bottom-0 left-0 z-50 w-full lg:hidden">
      <div className="bg-gradient-to-t from-bg-dark via-bg-dark to-transparent pb-4 pt-8">
        <div className="mx-4">
          <div className="group relative">
            {/* Glow effect */}
            <div className="absolute -inset-0.5 rounded-xl bg-gradient-to-r from-primary to-blue-600 opacity-30 blur transition duration-500 group-hover:opacity-60" />
            <div className="relative flex items-center gap-2 rounded-xl border border-surface-border bg-surface-dark p-2 shadow-2xl">
              <input
                type="text"
                value={message}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMessage(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    void handleSend()
                  }
                }}
                placeholder="Steer agent..."
                className="flex-1 bg-transparent px-2 text-sm text-white placeholder:text-slate-500 focus:outline-none"
                disabled={sending}
              />
              <button
                onClick={() => void handleSend()}
                disabled={sending || !message.trim()}
                className="flex size-9 items-center justify-center rounded-lg bg-primary text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[18px]">send</span>
              </button>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between px-2">
            <span className="text-[10px] text-slate-500">Press Enter to send</span>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              <span className="text-[10px] text-primary">Live Connection</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
