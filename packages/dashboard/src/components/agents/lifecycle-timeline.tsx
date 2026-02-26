"use client"

import type { AgentLifecycleState } from "@/lib/api-client"

export interface LifecycleStep {
  state: AgentLifecycleState
  timestamp?: string
}

interface LifecycleTimelineProps {
  currentState: AgentLifecycleState
  transitions: LifecycleStep[]
}

const LIFECYCLE_ORDER: AgentLifecycleState[] = [
  "BOOTING",
  "HYDRATING",
  "READY",
  "EXECUTING",
  "DRAINING",
  "TERMINATED",
]

const stepIcons: Record<AgentLifecycleState, string> = {
  BOOTING: "rocket_launch",
  HYDRATING: "database",
  READY: "check_circle",
  EXECUTING: "bolt",
  DRAINING: "water_drop",
  TERMINATED: "flag",
}

function formatStepTime(iso?: string): string {
  if (!iso) return ""
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    return ""
  }
}

type StepStatus = "completed" | "current" | "pending"

export function LifecycleTimeline({
  currentState,
  transitions,
}: LifecycleTimelineProps): React.JSX.Element {
  const currentIdx = LIFECYCLE_ORDER.indexOf(currentState)
  const transitionMap = new Map(transitions.map((t) => [t.state, t.timestamp]))

  function getStepStatus(idx: number): StepStatus {
    if (idx < currentIdx) return "completed"
    if (idx === currentIdx) return "current"
    return "pending"
  }

  return (
    <div className="hidden rounded-xl border border-surface-border bg-surface-light px-6 py-5 lg:block">
      <div className="mx-auto flex max-w-4xl items-center">
        {LIFECYCLE_ORDER.map((state, idx) => {
          const status = getStepStatus(idx)
          const ts = transitionMap.get(state)
          const isLast = idx === LIFECYCLE_ORDER.length - 1

          return (
            <div key={state} className="flex flex-1 items-center">
              {/* Step */}
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={`flex size-10 items-center justify-center rounded-full transition-all ${
                    status === "completed"
                      ? "bg-primary text-white shadow-lg shadow-primary/20"
                      : status === "current"
                        ? "bg-primary text-white ring-4 ring-primary/20 shadow-lg shadow-primary/30"
                        : "bg-secondary text-text-muted"
                  }`}
                >
                  <span
                    className={`material-symbols-outlined text-lg ${
                      status === "current" ? "animate-spin-slow" : ""
                    }`}
                  >
                    {status === "completed" ? "check" : stepIcons[state]}
                  </span>
                </div>
                <span
                  className={`text-[10px] font-bold uppercase tracking-wider ${
                    status === "current"
                      ? "text-primary"
                      : status === "completed"
                        ? "text-text-main"
                        : "text-slate-400"
                  }`}
                >
                  {state}
                </span>
                {ts && <span className="text-[10px] text-slate-500">{formatStepTime(ts)}</span>}
              </div>

              {/* Connecting line */}
              {!isLast && (
                <div className="mx-2 h-0.5 flex-1">
                  <div
                    className={`h-full rounded-full ${
                      status === "completed" || status === "current"
                        ? "bg-primary"
                        : "bg-secondary"
                    }`}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
