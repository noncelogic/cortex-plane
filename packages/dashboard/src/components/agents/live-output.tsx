"use client"

import { type AgentEventPayload, useAgentStream } from "@/hooks/use-agent-stream"

interface LiveOutputProps {
  agentId: string
}

function formatEventData(event: AgentEventPayload): string {
  switch (event.type) {
    case "agent:output":
      return event.data.output.content ?? JSON.stringify(event.data.output)
    case "agent:state":
      return event.data.state
    case "agent:error":
      return event.data.message
    case "agent:complete":
      return event.data.summary ?? "Job complete"
    case "steer:ack":
      return `Steer ${event.data.status}: ${event.data.steerMessageId}`
  }
}

export function LiveOutput({ agentId }: LiveOutputProps): React.JSX.Element {
  const { events, connected } = useAgentStream(agentId)

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-main">Live Output</h2>
        <span className={`text-xs ${connected ? "text-green-400" : "text-red-400"}`}>
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>
      <div className="h-96 overflow-auto rounded-lg border border-surface-border bg-console-bg p-4 font-mono text-sm text-slate-300">
        {events.length === 0 ? (
          <p className="text-text-muted">Waiting for output...</p>
        ) : (
          events.map((event, i) => (
            <div key={i} className="whitespace-pre-wrap">
              <span className="mr-2 text-text-muted">[{event.type}]</span>
              {formatEventData(event)}
            </div>
          ))
        )}
      </div>
    </section>
  )
}
