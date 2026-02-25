import { AgentControls } from "@/components/agents/agent-controls"
import { LiveOutput } from "@/components/agents/live-output"
import { SteerInput } from "@/components/agents/steer-input"
import { PageHeader } from "@/components/layout/page-header"

interface Props {
  params: Promise<{ agentId: string }>
}

export default async function AgentDetailPage({ params }: Props): Promise<React.JSX.Element> {
  const { agentId } = await params

  return (
    <main className="space-y-6">
      <PageHeader title={agentId} backHref="/" />
      <AgentControls agentId={agentId} />
      <LiveOutput agentId={agentId} />
      <SteerInput agentId={agentId} />
    </main>
  )
}
