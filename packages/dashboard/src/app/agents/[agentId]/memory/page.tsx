import { PageHeader } from "@/components/layout/page-header"
import { MemoryEditor } from "@/components/memory/memory-editor"
import { MemorySearch } from "@/components/memory/memory-search"

interface Props {
  params: Promise<{ agentId: string }>
}

export default async function AgentMemoryPage({ params }: Props): Promise<React.JSX.Element> {
  const { agentId } = await params

  return (
    <main className="space-y-6">
      <PageHeader title="Memory Explorer" backHref={`/agents/${agentId}`} />
      <MemorySearch agentId={agentId} />
      <MemoryEditor agentId={agentId} />
    </main>
  )
}
