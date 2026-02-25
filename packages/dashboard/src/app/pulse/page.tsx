import { PageHeader } from "@/components/layout/page-header"
import { DraftList } from "@/components/pulse/draft-list"
import { PipelineStats } from "@/components/pulse/pipeline-stats"

export default function PulsePage(): React.JSX.Element {
  return (
    <main className="space-y-6">
      <PageHeader title="AI Pulse" />
      <PipelineStats />
      <DraftList />
    </main>
  )
}
