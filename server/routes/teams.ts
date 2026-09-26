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

    const body = req.body as Record<string, unknown>;
    const { name, parentId, kind } = body ?? {};

    if (typeof name !== 'string' || name.trim().length === 0)
      return reply.status(400).send({ error: 'name is required' });
    if (kind !== 'department' && kind !== 'team')
      return reply.status(400).send({ error: "kind must be 'department' or 'team'" });

    const { project, revision } = mutateProject(db, sess.orgId, (p) => {
      // Validate parentId
      if (parentId !== undefined && parentId !== null) {
        if (typeof parentId !== 'string') throw Object.assign(new Error('Invalid parentId'), { statusCode: 400 });
        if (!p.teams.some((t) => t.id === parentId))
          throw Object.assign(new Error('Parent team not found'), { statusCode: 404 });
      }

      const teamId = randomUUID();
      const newTeam: Team = {
        id: teamId,
        name: name.trim(),
        parentId: typeof parentId === 'string' ? parentId : null,
        kind: kind as Team['kind'],
        space: { x: 0, y: 0, w: kind === 'team' ? 1200 : 0, h: kind === 'team' ? 480 : 0 },
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
    const body = req.body as Record<string, unknown>;

    const admin = isAdmin(db, sess.userId, sess.orgId);
    const editor = requireTeamAccess(db, sess.userId, sess.orgId, id, 'edit');

    if (!admin && !editor)
      return reply.status(403).send({ error: 'Insufficient permissions' });

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
      if (body.space && typeof body.space === 'object') {
        const s = body.space as Record<string, unknown>;
        updated.space = {
          x: typeof s.x === 'number' ? s.x : updated.space.x,
          y: typeof s.y === 'number' ? s.y : updated.space.y,
          w: typeof s.w === 'number' ? s.w : updated.space.w,
          h: typeof s.h === 'number' ? s.h : updated.space.h,
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
