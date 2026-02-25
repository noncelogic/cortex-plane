import { ApprovalList } from "@/components/approvals/approval-list"
import { PageHeader } from "@/components/layout/page-header"

export default function ApprovalsPage(): React.JSX.Element {
  return (
    <main className="space-y-6">
      <PageHeader title="Approvals" />
      <ApprovalList />
    </main>
  )
}
