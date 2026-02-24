import type { FastifyInstance } from "fastify"
import type { Runner } from "graphile-worker"

declare module "fastify" {
  interface FastifyInstance {
    worker: Runner
  }
}

export function healthRoutes(app: FastifyInstance): void {
  app.get("/healthz", async (_request, reply) => {
    return reply.send({ status: "ok" })
  })

  app.get("/readyz", async (_request, reply) => {
    const workerReady = app.worker !== undefined
    if (!workerReady) {
      return reply.status(503).send({ status: "not_ready", worker: false })
    }
    return reply.send({ status: "ok", worker: true })
  })
}
