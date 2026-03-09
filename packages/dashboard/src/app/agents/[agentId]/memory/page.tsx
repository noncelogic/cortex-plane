import { PhantomFeatureBanner } from "@/components/layout/phantom-feature-banner"
import { RoutePlaceholder } from "@/components/layout/route-placeholder"

interface Props {
  params: Promise<{ agentId: string }>
}

export default async function AgentMemoryPage({ params }: Props): Promise<React.JSX.Element> {
  const { agentId } = await params

  return (
    <div className="space-y-6">
      <PhantomFeatureBanner feature="Per-agent memory browsing" />
      <RoutePlaceholder title={`Memory: ${agentId}`} icon="memory" />
    </div>
  )
}
