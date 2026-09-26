import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_req, reply) => {
    return reply.send({ ok: true });
  });
}
