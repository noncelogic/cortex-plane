import { PageHeader } from "@/components/layout/page-header"
import { MemorySearch } from "@/components/memory/memory-search"

export default function MemoryPage(): React.JSX.Element {
  return (
    <main className="space-y-6">
      <PageHeader title="Memory Explorer" />
      <MemorySearch />
    </main>
  )
}
