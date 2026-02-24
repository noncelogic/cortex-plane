import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(healthRoutes);

  return app;
}
