import { JobTable } from "@/components/jobs/job-table"
import { PageHeader } from "@/components/layout/page-header"

export default function JobsPage(): React.JSX.Element {
  return (
    <main className="space-y-6">
      <PageHeader title="Job History" />
      <JobTable />
    </main>
  )
}
