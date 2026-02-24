import { QdrantClient } from "@qdrant/js-client-rest"

import { QdrantMemoryClient } from "./client.js"

export async function ensureCollection(
  agentSlug: string,
  options: { url?: string; apiKey?: string } = {},
): Promise<QdrantMemoryClient> {
  const memoryClient = new QdrantMemoryClient(agentSlug, options)

  const { collections } = await memoryClient.client.getCollections()
  const exists = collections.some((c) => c.name === memoryClient.collectionName)

  if (!exists) {
    await memoryClient.createCollection()
  }

  return memoryClient
}
