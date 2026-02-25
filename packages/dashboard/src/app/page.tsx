import { AgentGrid } from "@/components/agents/agent-grid"
import { ApprovalList } from "@/components/approvals/approval-list"
import { PageHeader } from "@/components/layout/page-header"

export default function Home(): React.JSX.Element {
  return (
    <main className="space-y-8">
      <PageHeader title="Dashboard" />
      <AgentGrid />
      <section>
        <h2 className="mb-4 text-lg font-semibold text-gray-200">Pending Approvals</h2>
        <ApprovalList filter="PENDING" />
      </section>
    </main>
  )
}
