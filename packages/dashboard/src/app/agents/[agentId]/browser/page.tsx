import { TabBar } from "@/components/browser/tab-bar"
import { TraceControls } from "@/components/browser/trace-controls"
import { VncViewer } from "@/components/browser/vnc-viewer"
import { PageHeader } from "@/components/layout/page-header"

interface Props {
  params: Promise<{ agentId: string }>
}

export default async function BrowserPage({ params }: Props): Promise<React.JSX.Element> {
  const { agentId } = await params

  return (
    <main className="space-y-4">
      <PageHeader title="Browser Observation" backHref={`/agents/${agentId}`} />
      <TabBar agentId={agentId} />
      <VncViewer agentId={agentId} />
      <TraceControls agentId={agentId} />
    </main>
  )
}
