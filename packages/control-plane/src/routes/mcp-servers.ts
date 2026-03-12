/**
 * MCP Server CRUD Routes
 *
 * POST   /mcp-servers              — Create MCP server
 * GET    /mcp-servers              — List MCP servers (supports ?status filter + pagination)
 * GET    /mcp-servers/:id          — Get MCP server by ID (includes tools)
 * PUT    /mcp-servers/:id          — Update MCP server
 * DELETE /mcp-servers/:id          — Delete MCP server (hard delete, cascades tools)
 * POST   /mcp-servers/:id/refresh  — Trigger re-probe (reset to PENDING)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { Kysely } from "kysely"

import {
  decrypt,
  deriveMasterKey,
  deserializeEncrypted,
  encrypt,
  serializeEncrypted,
} from "../auth/credential-encryption.js"
import type { SessionService } from "../auth/session-service.js"
import type { Database, McpServerStatus, McpTransport } from "../db/types.js"
import type { McpServerDeployer } from "../mcp/k8s-deployer.js"
import {
  type AuthMiddlewareOptions,
  createRequireAuth,
  createRequireRole,
  type PreHandler,
} from "../middleware/auth.js"
import type { AuthConfig } from "../middleware/types.js"

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface McpServerParams {
  id: string
}

interface CreateMcpServerBody {
  name: string
  slug?: string
  transport: McpTransport
  connection: Record<string, unknown>
  agent_scope?: string[]
  description?: string
  health_probe_interval_ms?: number
}

interface UpdateMcpServerBody {
  name?: string
  transport?: McpTransport
  connection?: Record<string, unknown>
  agent_scope?: string[]
  description?: string | null
  status?: McpServerStatus
  health_probe_interval_ms?: number
}

interface ListMcpServersQuery {
  status?: McpServerStatus
  limit?: number
  offset?: number
}

// ---------------------------------------------------------------------------
// Connection header encryption helpers
// ---------------------------------------------------------------------------

function encryptConnectionHeaders(
  connection: Record<string, unknown>,
  key: Buffer,
): Record<string, unknown> {
  const stored = { ...connection }
  if (stored.headers && typeof stored.headers === "object") {
    const encrypted = encrypt(JSON.stringify(stored.headers), key)
    stored.headers_enc = serializeEncrypted(encrypted)
    delete stored.headers
  }
  return stored
}

function decryptConnectionHeaders(
  connection: Record<string, unknown>,
  key: Buffer,
): Record<string, unknown> {
  const out = { ...connection }
  if (typeof out.headers_enc === "string") {
    const payload = deserializeEncrypted(out.headers_enc)
    out.headers = JSON.parse(decrypt(payload, key)) as Record<string, unknown>
    delete out.headers_enc
  }
  return out
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface McpServerRouteDeps {
  db: Kysely<Database>
  authConfig: AuthConfig
  sessionService?: SessionService
  /** Passphrase used to derive the encryption key for connection headers. */
  connectionEncryptionKey?: string
  /** K8s deployer for in-cluster MCP server deployments. */
  mcpDeployer?: McpServerDeployer
}

export function mcpServerRoutes(deps: McpServerRouteDeps) {
  const { db, authConfig, sessionService, connectionEncryptionKey, mcpDeployer } = deps

  const encryptionKey = connectionEncryptionKey
    ? deriveMasterKey(connectionEncryptionKey)
    : undefined

  const authOpts: AuthMiddlewareOptions = { config: authConfig, sessionService }
  const requireAuth: PreHandler = createRequireAuth(authOpts)
  const requireOperator: PreHandler = createRequireRole("operator")

  return function register(app: FastifyInstance): void {
    // -----------------------------------------------------------------
    // POST /mcp-servers — Create MCP server
    // -----------------------------------------------------------------
    app.post<{ Body: CreateMcpServerBody }>(
      "/mcp-servers",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          body: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 255 },
              slug: { type: "string", minLength: 1, maxLength: 255, pattern: "^[a-z0-9-]+$" },
              transport: { type: "string", enum: ["streamable-http", "stdio"] },
              connection: { type: "object" },
              agent_scope: { type: "array", items: { type: "string" } },
              description: { type: "string", maxLength: 2000 },
              health_probe_interval_ms: { type: "number", minimum: 1000, maximum: 3600000 },
            },
            required: ["name", "transport", "connection"],
          },
        },
      },
      async (request: FastifyRequest<{ Body: CreateMcpServerBody }>, reply: FastifyReply) => {
        const body = request.body
        const slug =
          body.slug ??
          body.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "")

        const connection = { ...body.connection }
        const image = connection.image as string | undefined

        // If image is provided, this is an in-cluster deployment
        const isInCluster =
          body.transport === "streamable-http" && typeof image === "string" && image.length > 0

        if (isInCluster && !mcpDeployer) {
          return reply.status(501).send({
            error: "not_implemented",
            message:
              "In-cluster MCP server deployment is not available (no k8s deployer configured)",
          })
        }

        const connectionToStore = encryptionKey
          ? encryptConnectionHeaders(connection, encryptionKey)
          : connection

        try {
          const server = await db
            .insertInto("mcp_server")
            .values({
              name: body.name,
              slug,
              transport: body.transport,
              connection: connectionToStore,
              agent_scope: body.agent_scope ?? [],
              description: body.description ?? null,
              health_probe_interval_ms: body.health_probe_interval_ms ?? 30000,
            })
            .returningAll()
            .executeTakeFirstOrThrow()

          // In-cluster deployment: create k8s resources and wait for readiness
          if (isInCluster && mcpDeployer) {
            try {
              const deployResult = await mcpDeployer.deploy({
                slug,
                image,
                port: (connection.port as number | undefined) ?? undefined,
                resources: connection.resources as { cpu?: string; memory?: string } | undefined,
                env: connection.env as Record<string, string> | undefined,
              })

              await mcpDeployer.waitForReady(slug)

              // Update connection with the in-cluster URL
              const updatedConnection = {
                ...connection,
                url: deployResult.url,
              }
              const updatedConnectionToStore = encryptionKey
                ? encryptConnectionHeaders(updatedConnection, encryptionKey)
                : updatedConnection

              await db
                .updateTable("mcp_server")
                .set({
                  connection: updatedConnectionToStore,
                  status: "ACTIVE" as McpServerStatus,
                  updated_at: new Date(),
                })
                .where("id", "=", server.id)
                .execute()

              const result = {
                ...server,
                connection: updatedConnection,
                status: "ACTIVE" as McpServerStatus,
              }
              return reply.status(201).send(result)
            } catch (deployErr: unknown) {
              // Deployment failed — mark server as ERROR with diagnostic
              const errorMessage =
                deployErr instanceof Error ? deployErr.message : "Unknown deployment error"

              await db
                .updateTable("mcp_server")
                .set({
                  status: "ERROR" as McpServerStatus,
                  error_message: errorMessage,
                  updated_at: new Date(),
                })
                .where("id", "=", server.id)
                .execute()

              const result = encryptionKey
                ? {
                    ...server,
                    connection: decryptConnectionHeaders(server.connection, encryptionKey),
                  }
                : server

              return reply.status(201).send({
                ...result,
                status: "ERROR" as McpServerStatus,
                error_message: errorMessage,
              })
            }
          }

          const result = encryptionKey
            ? { ...server, connection: decryptConnectionHeaders(server.connection, encryptionKey) }
            : server

          return reply.status(201).send(result)
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.message.includes("unique") &&
            err.message.includes("slug")
          ) {
            return reply.status(409).send({
              error: "conflict",
              message: `Slug '${slug}' is already in use`,
            })
          }
          throw err
        }
      },
    )

    // -----------------------------------------------------------------
    // GET /mcp-servers — List MCP servers
    // -----------------------------------------------------------------
    app.get<{ Querystring: ListMcpServersQuery }>(
      "/mcp-servers",
      {
        schema: {
          querystring: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["PENDING", "ACTIVE", "DEGRADED", "ERROR", "DISABLED"],
              },
              limit: { type: "number", minimum: 1, maximum: 100 },
              offset: { type: "number", minimum: 0 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Querystring: ListMcpServersQuery }>,
        reply: FastifyReply,
      ) => {
        const { status, limit = 50, offset = 0 } = request.query

        let query = db
          .selectFrom("mcp_server")
          .selectAll("mcp_server")
          .select((eb) =>
            eb
              .selectFrom("mcp_server_tool")
              .select(eb.fn.countAll<number>().as("cnt"))
              .whereRef("mcp_server_tool.mcp_server_id", "=", "mcp_server.id")
              .as("tool_count"),
          )
        let countQuery = db.selectFrom("mcp_server").select(db.fn.countAll<number>().as("total"))

        if (status) {
          query = query.where("status", "=", status)
          countQuery = countQuery.where("status", "=", status)
        }

        const [servers, countResult] = await Promise.all([
          query.orderBy("created_at", "desc").limit(limit).offset(offset).execute(),
          countQuery.executeTakeFirstOrThrow(),
        ])

        const total = Number(countResult.total)

        const items = servers.map((s) => ({
          ...s,
          tool_count: Number(s.tool_count ?? 0),
          connection: encryptionKey
            ? decryptConnectionHeaders(s.connection, encryptionKey)
            : s.connection,
        }))

        return reply.status(200).send({
          servers: items,
          count: items.length,
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + items.length < total,
          },
        })
      },
    )

    // -----------------------------------------------------------------
    // GET /mcp-servers/:id — Get MCP server by ID (with tools)
    // -----------------------------------------------------------------
    app.get<{ Params: McpServerParams }>(
      "/mcp-servers/:id",
      {
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: McpServerParams }>, reply: FastifyReply) => {
        const server = await db
          .selectFrom("mcp_server")
          .selectAll()
          .where("id", "=", request.params.id)
          .executeTakeFirst()

        if (!server) {
          return reply.status(404).send({ error: "not_found", message: "MCP server not found" })
        }

        const tools = await db
          .selectFrom("mcp_server_tool")
          .selectAll()
          .where("mcp_server_id", "=", server.id)
          .orderBy("name", "asc")
          .execute()

        const connection = encryptionKey
          ? decryptConnectionHeaders(server.connection, encryptionKey)
          : server.connection

        return reply.status(200).send({ ...server, connection, tools })
      },
    )

    // -----------------------------------------------------------------
    // PUT /mcp-servers/:id — Update MCP server
    // -----------------------------------------------------------------
    app.put<{ Params: McpServerParams; Body: UpdateMcpServerBody }>(
      "/mcp-servers/:id",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
          body: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 255 },
              transport: { type: "string", enum: ["streamable-http", "stdio"] },
              connection: { type: "object" },
              agent_scope: { type: "array", items: { type: "string" } },
              description: { type: ["string", "null"], maxLength: 2000 },
              status: {
                type: "string",
                enum: ["PENDING", "ACTIVE", "DEGRADED", "ERROR", "DISABLED"],
              },
              health_probe_interval_ms: { type: "number", minimum: 1000, maximum: 3600000 },
            },
          },
        },
      },
      async (
        request: FastifyRequest<{ Params: McpServerParams; Body: UpdateMcpServerBody }>,
        reply: FastifyReply,
      ) => {
        const { id } = request.params
        const body = request.body

        const updateValues: Record<string, unknown> = {}
        if (body.name !== undefined) updateValues.name = body.name
        if (body.transport !== undefined) updateValues.transport = body.transport
        if (body.connection !== undefined) {
          updateValues.connection = encryptionKey
            ? encryptConnectionHeaders(body.connection, encryptionKey)
            : body.connection
        }
        if (body.agent_scope !== undefined) updateValues.agent_scope = body.agent_scope
        if (body.description !== undefined) updateValues.description = body.description
        if (body.status !== undefined) updateValues.status = body.status
        if (body.health_probe_interval_ms !== undefined)
          updateValues.health_probe_interval_ms = body.health_probe_interval_ms

        if (Object.keys(updateValues).length === 0) {
          return reply.status(400).send({ error: "bad_request", message: "No fields to update" })
        }

        updateValues.updated_at = new Date()

        const updated = await db
          .updateTable("mcp_server")
          .set(updateValues)
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst()

        if (!updated) {
          return reply.status(404).send({ error: "not_found", message: "MCP server not found" })
        }

        const result = encryptionKey
          ? { ...updated, connection: decryptConnectionHeaders(updated.connection, encryptionKey) }
          : updated

        return reply.status(200).send(result)
      },
    )

    // -----------------------------------------------------------------
    // DELETE /mcp-servers/:id — Delete MCP server
    // Sets status to DISABLED first for graceful client disconnect,
    // then hard-deletes (cascades to mcp_server_tool).
    // -----------------------------------------------------------------
    app.delete<{ Params: McpServerParams }>(
      "/mcp-servers/:id",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: McpServerParams }>, reply: FastifyReply) => {
        const { id } = request.params

        // Set DISABLED first so any live clients can detect the status change
        await db
          .updateTable("mcp_server")
          .set({ status: "DISABLED" as McpServerStatus, updated_at: new Date() })
          .where("id", "=", id)
          .execute()

        const deleted = await db
          .deleteFrom("mcp_server")
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst()

        if (!deleted) {
          return reply.status(404).send({ error: "not_found", message: "MCP server not found" })
        }

        // Clean up k8s resources if this was an in-cluster deployment
        if (mcpDeployer && typeof deleted.connection === "object" && deleted.connection !== null) {
          const conn = deleted.connection
          if (typeof conn.image === "string") {
            await mcpDeployer.teardown(deleted.slug).catch(() => {
              // Best-effort cleanup — log but don't fail the delete
            })
          }
        }

        return reply.status(200).send(deleted)
      },
    )

    // -----------------------------------------------------------------
    // POST /mcp-servers/:id/refresh — Trigger re-probe
    // Resets status to PENDING and clears error state so the
    // health probe picks it up on its next cycle.
    // -----------------------------------------------------------------
    app.post<{ Params: McpServerParams }>(
      "/mcp-servers/:id/refresh",
      {
        preHandler: [requireAuth, requireOperator],
        schema: {
          params: {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
            },
            required: ["id"],
          },
        },
      },
      async (request: FastifyRequest<{ Params: McpServerParams }>, reply: FastifyReply) => {
        const updated = await db
          .updateTable("mcp_server")
          .set({
            status: "PENDING" as McpServerStatus,
            error_message: null,
            updated_at: new Date(),
          })
          .where("id", "=", request.params.id)
          .returningAll()
          .executeTakeFirst()

        if (!updated) {
          return reply.status(404).send({ error: "not_found", message: "MCP server not found" })
        }

        return reply.status(200).send(updated)
      },
    )
  }
}
