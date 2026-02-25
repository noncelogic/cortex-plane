import { RoutePlaceholder } from "@/components/layout/route-placeholder"

interface Props {
  params: Promise<{ agentId: string }>
}

export default async function BrowserPage({ params }: Props): Promise<React.JSX.Element> {
  const { agentId } = await params

  return <RoutePlaceholder title={`Browser: ${agentId}`} icon="web" />
}
