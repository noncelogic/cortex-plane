import type { FastifyInstance } from "fastify";

export function healthRoutes(app: FastifyInstance): void {
  app.get("/healthz", async (_request, reply) => {
    return reply.send({ status: "ok" });
  });

  app.get("/readyz", async (_request, reply) => {
    // TODO: check PostgreSQL and Graphile Worker connectivity
    return reply.send({ status: "ok" });
  });
}
