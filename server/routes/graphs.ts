import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { GraphContext } from '../../src/types.js';
import { resolveSession } from '../session.js';
import { mutateProject, isAdmin, requireTeamAccess } from '../db.js';
import { validateWorkspaceBinding } from './validate.js';

export async function graphsRoutes(app: FastifyInstance): Promise<void> {
  const db: DatabaseSync = app.db;

  app.post('/api/graphs', async (req, reply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
      return reply.status(400).send({ error: 'Request body must be a JSON object' });
    const body = req.body as Record<string, unknown>;
    if (typeof body.teamId !== 'string' || typeof body.name !== 'string' || !body.name.trim() ||
        (body.goal !== undefined && typeof body.goal !== 'string'))
      return reply.status(400).send({ error: 'teamId and name required; goal must be a string' });
    if (!body.workspace) return reply.status(400).send({ error: 'Project workspace path, branch and ref are required' });
    const wsErr = validateWorkspaceBinding(body.workspace);
    if (wsErr) return reply.status(400).send({ error: wsErr });
    const ws = body.workspace as { path: string; branch: string; ref: string };
    const teamId = body.teamId;
    const graph: GraphContext = { id: randomUUID(), teamId, name: body.name.trim(), goal: body.goal as string ?? '', repo: '', conventions: '', workspace: { path: ws.path.trim(), branch: ws.branch.trim(), ref: ws.ref.trim() } };
    const { revision } = mutateProject(db, sess.orgId, p => {
      if (!p.teams.some(t => t.id === teamId)) throw Object.assign(new Error('Team not found'), { statusCode: 404 });
      if (!requireTeamAccess(db, sess.userId, sess.orgId, teamId, 'edit')) throw Object.assign(new Error('Editor access required'), { statusCode: 403 });
      return { ...p, graphContexts: [...p.graphContexts, graph] };
    });
    return reply.status(201).send({ ...graph, revision });
  });

  // ------------------------------------------------------------------
  // PATCH /api/graphs/:id — update graph context
  // ------------------------------------------------------------------
  app.patch('/api/graphs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    if (req.body === null || req.body === undefined || typeof req.body !== 'object' || Array.isArray(req.body))
      return reply.status(400).send({ error: 'Request body must be a JSON object' });

    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;

    // Validate workspace if supplied
    if (body.workspace !== undefined && body.workspace !== null) {
      const wsErr = validateWorkspaceBinding(body.workspace, 'workspace');
      if (wsErr) return reply.status(400).send({ error: wsErr });
    }

    const { project, revision } = mutateProject(db, sess.orgId, (p) => {
      const idx = p.graphContexts.findIndex((g) => g.id === id);
      if (idx === -1) throw Object.assign(new Error('GraphContext not found'), { statusCode: 404 });

      const graph = p.graphContexts[idx]!;

      // Access check
      if (!isAdmin(db, sess.userId, sess.orgId) &&
          !requireTeamAccess(db, sess.userId, sess.orgId, graph.teamId, 'edit'))
        throw Object.assign(new Error('Editor access required'), { statusCode: 403 });

      if ('workspace' in body && (app.runtime.graphActive(sess.orgId, id) || p.nodes.some(n => n.graphId === id && app.runtime.nodeActive(sess.orgId, n.id))))
        throw Object.assign(new Error('Cannot change workspace during active execution'), { statusCode: 409 });
      if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim()))
        throw Object.assign(new Error('name must be a non-empty string'), { statusCode: 400 });
      const updated: GraphContext = { ...graph };
      if (typeof body.name === 'string') updated.name = body.name.trim();
      if (typeof body.goal === 'string') updated.goal = body.goal;
      if (typeof body.repo === 'string') updated.repo = body.repo;
      if (typeof body.conventions === 'string') updated.conventions = body.conventions;

      // workspace: null clears the binding, object sets it
      if ('workspace' in body) {
        if (body.workspace === null) {
          delete updated.workspace;
        } else if (typeof body.workspace === 'object') {
          updated.workspace = body.workspace as GraphContext['workspace'];
        }
      }

      const graphs = [...p.graphContexts];
      graphs[idx] = updated;
      return { ...p, graphContexts: graphs };
    });

    const updatedGraph = project.graphContexts.find((g) => g.id === id);
    return reply.send({ ...updatedGraph, revision });
  });
}
