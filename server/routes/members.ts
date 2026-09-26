import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { resolveSession } from '../session.js';
import { hashPassword } from '../auth.js';
import { getUserMembership, isAdmin } from '../db.js';

export async function membersRoutes(app: FastifyInstance): Promise<void> {
  const db: DatabaseSync = app.db;

  // ------------------------------------------------------------------
  // GET /api/members — admin only
  // ------------------------------------------------------------------
  app.get('/api/members', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    if (!isAdmin(db, sess.userId, sess.orgId))
      return reply.status(403).send({ error: 'Admin access required' });

    const members = db
      .prepare(
        `SELECT u.id, u.email, u.name, om.role
         FROM users u
         JOIN org_memberships om ON om.userId = u.id
         WHERE om.orgId = ?`,
      )
      .all(sess.orgId) as { id: string; email: string; name: string; role: string }[];

    // Include team memberships for each member
    const result = members.map((m) => {
      const teamRoles = db
        .prepare('SELECT teamId, role FROM team_memberships WHERE userId = ? AND orgId = ?')
        .all(m.id, sess.orgId) as { teamId: string; role: string }[];
      return { id: m.id, email: m.email, name: m.name, role: m.role, teamRoles };
    });

    return reply.send(result);
  });

  // ------------------------------------------------------------------
  // POST /api/members — admin only; create account in current org
  // ------------------------------------------------------------------
  app.post('/api/members', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    if (!isAdmin(db, sess.userId, sess.orgId))
      return reply.status(403).send({ error: 'Admin access required' });

    const body = req.body as Record<string, unknown>;
    const { email, password, name, role } = body ?? {};

    if (typeof email !== 'string' || !email.includes('@'))
      return reply.status(400).send({ error: 'Invalid email' });
    if (typeof password !== 'string' || password.length < 10)
      return reply.status(400).send({ error: 'Password must be at least 10 characters' });
    if (typeof name !== 'string' || name.trim().length === 0)
      return reply.status(400).send({ error: 'name is required' });
    if (role !== 'admin' && role !== 'member')
      return reply.status(400).send({ error: "role must be 'admin' or 'member'" });

    const normalizedEmail = email.toLowerCase().trim();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) return reply.status(409).send({ error: 'Email already registered' });

    const { hash, salt } = await hashPassword(password);
    const userId = randomUUID();

    db.prepare('BEGIN').run();
    try {
      db.prepare(
        'INSERT INTO users (id, email, name, passwordHash, salt) VALUES (?, ?, ?, ?, ?)',
      ).run(userId, normalizedEmail, name.trim(), hash, salt);
      db.prepare('INSERT INTO org_memberships (userId, orgId, role) VALUES (?, ?, ?)').run(
        userId,
        sess.orgId,
        role,
      );
      db.prepare('COMMIT').run();
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }

    const mem = getUserMembership(db, userId, sess.orgId);
    if (!mem) return reply.status(500).send({ error: 'Failed to create member' });
    return reply.status(201).send({
      id: mem.user.id,
      email: mem.user.email,
      name: mem.user.name,
      role: mem.orgRole,
      teamRoles: [],
    });
  });

  // ------------------------------------------------------------------
  // PUT /api/teams/:teamId/members/:userId — admin only; set team role
  // ------------------------------------------------------------------
  app.put(
    '/api/teams/:teamId/members/:userId',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const sess = resolveSession(db, req, reply);
      if (!sess) return;

      if (!isAdmin(db, sess.userId, sess.orgId))
        return reply.status(403).send({ error: 'Admin access required' });

      const { teamId, userId } = req.params as { teamId: string; userId: string };
      const body = req.body as Record<string, unknown>;
      const { role } = body ?? {};

      if (role !== 'editor' && role !== 'viewer')
        return reply.status(400).send({ error: "role must be 'editor' or 'viewer'" });

      // Verify team belongs to org
      const projectRow = db.prepare('SELECT data FROM projects WHERE orgId = ?').get(sess.orgId) as
        | { data: string }
        | undefined;
      if (!projectRow) return reply.status(404).send({ error: 'Project not found' });
      const project = JSON.parse(projectRow.data) as { teams: { id: string }[] };
      if (!project.teams.some((t) => t.id === teamId))
        return reply.status(404).send({ error: 'Team not found in this organization' });

      // Verify target user belongs to org
      const targetMem = db
        .prepare('SELECT userId FROM org_memberships WHERE userId = ? AND orgId = ?')
        .get(userId, sess.orgId);
      if (!targetMem) return reply.status(404).send({ error: 'User not found in this organization' });

      // Upsert
      db.prepare(
        `INSERT INTO team_memberships (userId, orgId, teamId, role)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(userId, orgId, teamId) DO UPDATE SET role = excluded.role`,
      ).run(userId, sess.orgId, teamId, role);

      return reply.send({ userId, teamId, role });
    },
  );
}
