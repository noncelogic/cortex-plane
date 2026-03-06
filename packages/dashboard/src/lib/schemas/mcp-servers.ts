import { z } from "zod"

import { PaginationSchema } from "./common"

export const McpTransportSchema = z.enum(["streamable-http", "stdio"])

export const McpServerStatusSchema = z.enum(["PENDING", "ACTIVE", "DEGRADED", "ERROR", "DISABLED"])

export const McpServerToolSchema = z.object({
  id: z.string(),
  mcp_server_id: z.string(),
  name: z.string(),
  qualified_name: z.string(),
  description: z.string().optional().nullable(),
  input_schema: z.record(z.string(), z.unknown()),
  annotations: z.record(z.string(), z.unknown()).optional().nullable(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const McpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  transport: McpTransportSchema,
  connection: z.record(z.string(), z.unknown()),
  agent_scope: z.array(z.string()),
  description: z.string().optional().nullable(),
  status: McpServerStatusSchema,
  protocol_version: z.string().optional().nullable(),
  server_info: z.record(z.string(), z.unknown()).optional().nullable(),
  capabilities: z.record(z.string(), z.unknown()).optional().nullable(),
  health_probe_interval_ms: z.number(),
  last_healthy_at: z.string().optional().nullable(),
  error_message: z.string().optional().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const McpServerDetailSchema = McpServerSchema.extend({
  tools: z.array(McpServerToolSchema).optional().default([]),
})

export const McpServerListResponseSchema = z
  .object({
    servers: z.array(McpServerSchema),
    pagination: PaginationSchema.optional(),
    count: z.number().optional(),
  })
  .transform((data) => {
    if (data.pagination) {
      return { servers: data.servers, pagination: data.pagination }
    }
    const total = data.count ?? data.servers.length
    return {
      servers: data.servers,
      pagination: { total, limit: total, offset: 0, hasMore: false },
    }
  })

export type McpTransport = z.infer<typeof McpTransportSchema>
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>
export type McpServerTool = z.infer<typeof McpServerToolSchema>
export type McpServer = z.infer<typeof McpServerSchema>
export type McpServerDetail = z.infer<typeof McpServerDetailSchema>
