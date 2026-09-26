import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Project, Team, GraphContext } from '../../src/types.js';
import { resolveSession } from '../session.js';
import { mutateProject, isAdmin, requireTeamAccess } from '../db.js';

// Check for hierarchy cycle: would setting team.parentId = newParentId create a cycle?
function wouldCreateCycle(teams: Team[], teamId: string, newParentId: string): boolean {
  const map = new Map(teams.map((t) => [t.id, t]));
  let cur: Team | undefined = map.get(newParentId);
  while (cur) {
    if (cur.id === teamId) return true;
    cur = cur.parentId ? map.get(cur.parentId) : undefined;
  }
  return false;
}

/**
 * Validate an optional partial space object supplied by the client.
 * Returns { error } if invalid, or { space } with the validated partial dimensions.
 * Only supplied keys are checked; absent keys are left to the caller to fill.
 * w and h must be >= 0; x and y may be any finite number (negative/fractional ok).
 */
function validatePartialSpace(
  raw: unknown,
): { error: string } | { space: Partial<{ x: number; y: number; w: number; h: number }> } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'space must be a plain object' };
  const s = raw as Record<string, unknown>;
  const result: Partial<{ x: number; y: number; w: number; h: number }> = {};
  for (const dim of ['x', 'y', 'w', 'h'] as const) {
    if (!(dim in s)) continue;
    const v = s[dim];
    if (typeof v !== 'number' || !isFinite(v))
      return { error: `space.${dim} must be a finite number` };
    if ((dim === 'w' || dim === 'h') && v < 0)
      return { error: `space.${dim} must be >= 0` };
    result[dim] = v;
  }
  return { space: result };
}

export async function teamsRoutes(app: FastifyInstance): Promise<void> {
  const db: DatabaseSync = app.db;

  // ------------------------------------------------------------------
  // GET /api/teams — authenticated; returns hierarchy visible to user
  // ------------------------------------------------------------------
  app.get('/api/teams', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    const projectRow = db.prepare('SELECT data FROM projects WHERE orgId = ?').get(sess.orgId) as
      | { data: string }
      | undefined;
    if (!projectRow) return reply.status(404).send({ error: 'Project not found' });

    const project = JSON.parse(projectRow.data) as Project;

    if (isAdmin(db, sess.userId, sess.orgId)) {
      return reply.send(project.teams);
    }

    // Filter by access
    const visible = project.teams.filter((t) =>
      requireTeamAccess(db, sess.userId, sess.orgId, t.id, 'read'),
    );
    return reply.send(visible);
  });

  // ------------------------------------------------------------------
  // POST /api/teams — admin only
  // ------------------------------------------------------------------
  app.post('/api/teams', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    if (!isAdmin(db, sess.userId, sess.orgId))
      return reply.status(403).send({ error: 'Admin access required' });

    // Reject null or non-object body before dereference
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body))
      return reply.status(400).send({ error: 'Request body must be a JSON object' });

    const body = req.body as Record<string, unknown>;
    const { name, parentId, kind } = body;

    if (typeof name !== 'string' || name.trim().length === 0)
      return reply.status(400).send({ error: 'name is required' });
    if (kind !== 'department' && kind !== 'team')
      return reply.status(400).send({ error: "kind must be 'department' or 'team'" });

    // Validate optional space
    let clientSpace: Partial<{ x: number; y: number; w: number; h: number }> | undefined;
    if (body.space !== undefined) {
      const result = validatePartialSpace(body.space);
      if ('error' in result) return reply.status(400).send({ error: result.error });
      clientSpace = result.space;
    }

    const { project, revision } = mutateProject(db, sess.orgId, (p) => {
      // Validate parentId
      if (parentId !== undefined && parentId !== null) {
        if (typeof parentId !== 'string') throw Object.assign(new Error('Invalid parentId'), { statusCode: 400 });
        if (!p.teams.some((t) => t.id === parentId))
          throw Object.assign(new Error('Parent team not found'), { statusCode: 404 });
      }

      const teamId = randomUUID();
      const kindDefaults = {
        x: 0,
        y: 0,
        w: kind === 'team' ? 1200 : 0,
        h: kind === 'team' ? 480 : 0,
      };
      const newTeam: Team = {
        id: teamId,
        name: name.trim(),
        parentId: typeof parentId === 'string' ? parentId : null,
        kind: kind as Team['kind'],
        space: {
          x: clientSpace?.x ?? kindDefaults.x,
          y: clientSpace?.y ?? kindDefaults.y,
          w: clientSpace?.w ?? kindDefaults.w,
          h: clientSpace?.h ?? kindDefaults.h,
        },
      };

      const newGraphs: GraphContext[] = [];
      if (kind === 'team') {
        // Create a default GraphContext for the team
        newGraphs.push({
          id: randomUUID(),
          teamId,
          goal: '',
          repo: '',
          conventions: '',
        });
      }

      return {
        ...p,
        teams: [...p.teams, newTeam],
        graphContexts: [...p.graphContexts, ...newGraphs],
      };
    });

    const createdTeam = project.teams[project.teams.length - 1];
    return reply.status(201).send({ ...createdTeam, revision });
  });

  // ------------------------------------------------------------------
  // PATCH /api/teams/:id — admin (all fields), editor (position/label)
  // ------------------------------------------------------------------
  app.patch('/api/teams/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    const { id } = req.params as { id: string };

    // Reject null or non-object body before dereference
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body))
      return reply.status(400).send({ error: 'Request body must be a JSON object' });

    const body = req.body as Record<string, unknown>;

    const admin = isAdmin(db, sess.userId, sess.orgId);
    const editor = requireTeamAccess(db, sess.userId, sess.orgId, id, 'edit');

    if (!admin && !editor)
      return reply.status(403).send({ error: 'Insufficient permissions' });

    // Validate optional space before mutation
    let spacePatch: Partial<{ x: number; y: number; w: number; h: number }> | undefined;
    if (body.space !== undefined) {
      const result = validatePartialSpace(body.space);
      if ('error' in result) return reply.status(400).send({ error: result.error });
      spacePatch = result.space;
    }

    const { project, revision } = mutateProject(db, sess.orgId, (p) => {
      const idx = p.teams.findIndex((t) => t.id === id);
      if (idx === -1) throw Object.assign(new Error('Team not found'), { statusCode: 404 });

      const team = p.teams[idx]!;
      const updated = { ...team };

      if (admin) {
        if (typeof body.name === 'string') updated.name = body.name.trim();
        if (body.parentId !== undefined) {
          if (body.parentId === null) {
            updated.parentId = null;
          } else if (typeof body.parentId === 'string') {
            if (!p.teams.some((t) => t.id === body.parentId))
              throw Object.assign(new Error('Parent team not found'), { statusCode: 404 });
            if (wouldCreateCycle(p.teams, id, body.parentId as string))
              throw Object.assign(new Error('Hierarchy cycle detected'), { statusCode: 400 });
            updated.parentId = body.parentId;
          }
        }
      }

      // Both admin and editor can change these
      if (typeof body.currentTaskLabel === 'string')
        updated.currentTaskLabel = body.currentTaskLabel;
      if (spacePatch !== undefined) {
        updated.space = {
          x: spacePatch.x ?? updated.space.x,
          y: spacePatch.y ?? updated.space.y,
          w: spacePatch.w ?? updated.space.w,
          h: spacePatch.h ?? updated.space.h,
        };
      }

      const teams = [...p.teams];
      teams[idx] = updated;
      return { ...p, teams };
    });

    const updatedTeam = project.teams.find((t) => t.id === id);
    return reply.send({ ...updatedTeam, revision });
  });
}
