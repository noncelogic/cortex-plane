import { RoutePlaceholder } from "@/components/layout/route-placeholder"

interface Props {
  params: Promise<{ agentId: string }>
}

export default async function AgentMemoryPage({ params }: Props): Promise<React.JSX.Element> {
  const { agentId } = await params

  return <RoutePlaceholder title={`Memory: ${agentId}`} icon="memory" />
}
