import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { GraphContext } from '../../src/types.js';
import { resolveSession } from '../session.js';
import { mutateProject, isAdmin, requireTeamAccess } from '../db.js';
import { validateWorkspaceBinding } from './validate.js';

export async function graphsRoutes(app: FastifyInstance): Promise<void> {
  const db: DatabaseSync = app.db;

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

      const updated: GraphContext = { ...graph };
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
