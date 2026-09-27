import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readProject, requireTeamAccess } from '../db.js';
import { resolveSession, type SessionInfo } from '../session.js';
import type { Runtime } from '../runtime.js';
import type { WorkerNode, ExecutionInitiator } from '../../src/types.js';

declare module 'fastify' { interface FastifyInstance { runtime: Runtime } }

export async function runtimeRoutes(app: FastifyInstance): Promise<void> {
  const runtime = app.runtime;
  function initiator(session: SessionInfo): ExecutionInitiator | undefined {
    const user = app.db.prepare('SELECT id, name FROM users WHERE id=?').get(session.userId) as ExecutionInitiator | undefined;
    return user && { id: user.id, name: user.name };
  }
  app.get('/api/run-monitor', async (req, reply) => {
    const session = resolveSession(app.db, req, reply);
    if (!session) return;
    return runtime.monitor(session.orgId, session.userId);
  });
  function authorize(req: FastifyRequest, reply: FastifyReply, kind: 'node' | 'graph', access: 'read' | 'edit'): SessionInfo | null {
    const session = resolveSession(app.db, req, reply);
    if (!session) return null;
    const { id } = req.params as { id: string };
    const resource = kind === 'node' ? runtime.node(session.orgId, id) : runtime.graph(session.orgId, id);
    if (!requireTeamAccess(app.db, session.userId, session.orgId, resource.teamId, access)) {
      reply.status(403).send({ error: access === 'edit' ? 'Editor access required' : 'Reader access required' }); return null;
    }
    return session;
  }
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  function body(req: FastifyRequest): Record<string, unknown> {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw Object.assign(new Error('Request body must be a JSON object'), { statusCode: 400 });
    return req.body as Record<string, unknown>;
  }
  app.post('/api/nodes/:id/run', async (req, reply) => {
    const s = authorize(req, reply, 'node', 'edit'); if (!s) return;
    return reply.status(202).send(runtime.runNode(s.orgId, id(req), initiator(s)));
  });
  app.post('/api/nodes/:id/cancel', async (req, reply) => {
    const s = authorize(req, reply, 'node', 'edit'); if (!s) return;
    if (req.body !== undefined) {
      const expected = body(req).attemptId;
      if (expected !== undefined && typeof expected !== 'string') return reply.status(400).send({ error: 'Invalid attemptId' });
      if (expected !== undefined && runtime.node(s.orgId, id(req)).currentAttemptId !== expected)
        return reply.status(409).send({ error: 'This task has a different current attempt. Refresh before canceling.' });
    }
    return runtime.cancelNode(s.orgId, id(req));
  });
  app.get('/api/nodes/:id/attempts', async (req, reply) => {
    const s = authorize(req, reply, 'node', 'read'); if (!s) return;
    return runtime.attempts(s.orgId, id(req));
  });
  app.post('/api/nodes/:id/decision', async (req, reply) => {
    const s = authorize(req, reply, 'node', 'edit'); if (!s) return;
    const b = body(req);
    if (typeof b.attemptId !== 'string' || !['approve', 'request_changes'].includes(String(b.decision)) || (b.targetNodeId !== undefined && typeof b.targetNodeId !== 'string') || (b.feedback !== undefined && typeof b.feedback !== 'string')) return reply.status(400).send({ error: 'Invalid gate decision' });
    return runtime.decision(s.orgId, id(req), b.attemptId, b.decision as 'approve' | 'request_changes', s.userId, b.targetNodeId as string | undefined, b.feedback as string | undefined);
  });
  app.post('/api/graphs/:id/run', async (req, reply) => {
    const s = authorize(req, reply, 'graph', 'edit'); if (!s) return;
    return reply.status(202).send(runtime.runGraph(s.orgId, id(req), initiator(s)));
  });
  app.get('/api/graphs/:id/run', async (req, reply) => {
    const s = authorize(req, reply, 'graph', 'read'); if (!s) return;
    return runtime.latestRun(s.orgId, id(req));
  });
  app.post('/api/graphs/:id/run/cancel', async (req, reply) => {
    const s = authorize(req, reply, 'graph', 'edit'); if (!s) return;
    if (req.body !== undefined) {
      const expected = body(req).runId;
      if (expected !== undefined && typeof expected !== 'string') return reply.status(400).send({ error: 'Invalid runId' });
      if (expected !== undefined && runtime.latestRun(s.orgId, id(req))?.id !== expected)
        return reply.status(409).send({ error: 'This project has a different current run. Refresh before canceling.' });
    }
    return runtime.cancelGraph(s.orgId, id(req));
  });
  app.post('/api/graphs/:id/resume', async (req, reply) => {
    const s = authorize(req, reply, 'graph', 'edit'); if (!s) return;
    return reply.status(202).send(runtime.resume(s.orgId, id(req)));
  });
  app.get('/api/team-directory', async (req, reply) => {
    const s = resolveSession(app.db, req, reply); if (!s) return;
    return (readProject(app.db, s.orgId)?.project.teams ?? []).map(({ id, name, parentId, kind }) => ({ id, name, parentId, kind }));
  });
  app.post('/api/nodes/:id/handoff', async (req, reply) => {
    const s = authorize(req, reply, 'node', 'edit'); if (!s) return;
    const b = body(req);
    if (typeof b.targetTeamId !== 'string' || !b.targetTeamId || typeof b.requestId !== 'string' || !b.requestId.trim() || typeof b.message !== 'string' || !b.message.trim() || (b.sourceAttemptId !== undefined && typeof b.sourceAttemptId !== 'string') || (b.priority !== undefined && !['low', 'normal', 'high', 'critical'].includes(String(b.priority)))) return reply.status(400).send({ error: 'Invalid handoff request' });
    const user = app.db.prepare('SELECT email FROM users WHERE id=?').get(s.userId) as { email: string } | undefined;
    return reply.status(201).send(runtime.handoff(s.orgId, id(req), user?.email ?? s.userId, { targetTeamId: b.targetTeamId, requestId: b.requestId, message: b.message, sourceAttemptId: b.sourceAttemptId as string | undefined, priority: b.priority as WorkerNode['priority'] | undefined }));
  });
  app.get('/api/nodes/:id/handoffs', async (req, reply) => {
    const s = authorize(req, reply, 'node', 'read'); if (!s) return;
    return runtime.handoffs(s.orgId, id(req));
  });
}
