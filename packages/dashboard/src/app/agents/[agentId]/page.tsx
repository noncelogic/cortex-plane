import { RoutePlaceholder } from "@/components/layout/route-placeholder"

interface Props {
  params: Promise<{ agentId: string }>
}

export default async function AgentDetailPage({ params }: Props): Promise<React.JSX.Element> {
  const { agentId } = await params

  return <RoutePlaceholder title={`Agent: ${agentId}`} icon="smart_toy" />
}
