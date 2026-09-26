import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../../src/types.js';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
} from '../auth.js';
import {
  readProject,
  getUserMembership,
  BUILTIN_TEMPLATES,
} from '../db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'tw_session';
// Match the stored hash/salt sizes so unknown users pay the same scrypt cost.
const LOGIN_DUMMY_HASH = '0'.repeat(128);
const LOGIN_DUMMY_SALT = '0'.repeat(64);

function buildUserResponse(db: DatabaseSync, userId: string, orgId: string) {
  const mem = getUserMembership(db, userId, orgId);
  if (!mem) return null;
  const orgRow = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(orgId) as
    | { id: string; name: string }
    | undefined;
  if (!orgRow) return null;
  return {
    user: { id: mem.user.id, email: mem.user.email, name: mem.user.name },
    organization: { id: orgRow.id, name: orgRow.name },
    role: mem.orgRole,
    teamRoles: mem.teamMemberships.map((m) => ({ teamId: m.teamId, role: m.role })),
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const db: DatabaseSync = app.db;
  const isProd = process.env.NODE_ENV === 'production';

  // ------------------------------------------------------------------
  // POST /api/auth/register
  // ------------------------------------------------------------------
  app.post('/api/auth/register', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown>;
    const { email, password, name, organizationName } = body ?? {};

    if (typeof email !== 'string' || !email.includes('@'))
      return reply.status(400).send({ error: 'Invalid email' });
    if (typeof password !== 'string' || password.length < 10)
      return reply.status(400).send({ error: 'Password must be at least 10 characters' });
    if (typeof name !== 'string' || name.trim().length === 0)
      return reply.status(400).send({ error: 'name is required' });
    if (typeof organizationName !== 'string' || organizationName.trim().length === 0)
      return reply.status(400).send({ error: 'organizationName is required' });

    const normalizedEmail = email.toLowerCase().trim();

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) return reply.status(409).send({ error: 'Email already registered' });

    const { hash, salt } = await hashPassword(password);
    const userId = randomUUID();
    const orgId = randomUUID();
    const rootTeamId = randomUUID();
    const graphId = randomUUID();

    // Empty project for new org — root team, no nodes, no graphs, built-in templates
    const project: Project = {
      version: 1,
      teams: [
        {
          id: rootTeamId,
          name: organizationName.trim(),
          parentId: null,
          kind: 'organization',
          space: { x: 0, y: 0, w: 0, h: 0 },
        },
      ],
      nodes: [],
      graphContexts: [
        {
          id: graphId,
          teamId: rootTeamId,
          goal: '',
          repo: '',
          conventions: '',
        },
      ],
      templates: [...BUILTIN_TEMPLATES],
    };

    // Atomic transaction: user + org + memberships + project
    const insertAll = db.prepare('BEGIN');
    insertAll.run();
    try {
      db.prepare(
        'INSERT INTO users (id, email, name, passwordHash, salt) VALUES (?, ?, ?, ?, ?)',
      ).run(userId, normalizedEmail, name.trim(), hash, salt);

      db.prepare('INSERT INTO organizations (id, name) VALUES (?, ?)').run(
        orgId,
        organizationName.trim(),
      );

      db.prepare(
        "INSERT INTO org_memberships (userId, orgId, role) VALUES (?, ?, 'admin')",
      ).run(userId, orgId);

      db.prepare(
        'INSERT INTO projects (orgId, revision, data) VALUES (?, 0, ?)',
      ).run(orgId, JSON.stringify(project));

      db.prepare('COMMIT').run();
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }

    // Create session
    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    db.prepare(
      'INSERT INTO sessions (tokenHash, userId, orgId, expiresAt) VALUES (?, ?, ?, ?)',
    ).run(tokenHash, userId, orgId, expiresAt);

    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: isProd,
      maxAge: SESSION_TTL_MS / 1000,
    });

    const response = buildUserResponse(db, userId, orgId);
    return reply.status(201).send(response);
  });

  // ------------------------------------------------------------------
  // POST /api/auth/login
  // ------------------------------------------------------------------
  app.post('/api/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown>;
    const { email, password } = body ?? {};

    if (typeof email !== 'string' || typeof password !== 'string')
      return reply.status(401).send({ error: 'Invalid credentials' });

    const normalizedEmail = email.toLowerCase().trim();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail) as
      | { id: string; email: string; name: string; passwordHash: string; salt: string }
      | undefined;

    const ok = await verifyPassword(
      password,
      user?.passwordHash ?? LOGIN_DUMMY_HASH,
      user?.salt ?? LOGIN_DUMMY_SALT,
    );
    if (!user || !ok) return reply.status(401).send({ error: 'Invalid credentials' });

    const orgMem = db.prepare('SELECT orgId FROM org_memberships WHERE userId = ?').get(user.id) as
      | { orgId: string }
      | undefined;
    if (!orgMem) return reply.status(401).send({ error: 'Invalid credentials' });

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    db.prepare(
      'INSERT INTO sessions (tokenHash, userId, orgId, expiresAt) VALUES (?, ?, ?, ?)',
    ).run(tokenHash, user.id, orgMem.orgId, expiresAt);

    reply.setCookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: isProd,
      maxAge: SESSION_TTL_MS / 1000,
    });

    const response = buildUserResponse(db, user.id, orgMem.orgId);
    return reply.send(response);
  });

  // ------------------------------------------------------------------
  // POST /api/auth/logout
  // ------------------------------------------------------------------
  app.post('/api/auth/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) {
      const tokenHash = hashToken(token);
      db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(tokenHash);
    }
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.send({ ok: true });
  });

  // ------------------------------------------------------------------
  // GET /api/auth/me
  // ------------------------------------------------------------------
  app.get('/api/auth/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return reply.status(401).send({ error: 'Not authenticated' });

    const tokenHash = hashToken(token);
    const session = db.prepare(
      'SELECT * FROM sessions WHERE tokenHash = ? AND expiresAt > ?',
    ).get(tokenHash, Date.now()) as { userId: string; orgId: string } | undefined;

    if (!session) return reply.status(401).send({ error: 'Session expired or invalid' });

    const response = buildUserResponse(db, session.userId, session.orgId);
    if (!response) return reply.status(401).send({ error: 'User not found' });
    return reply.send(response);
  });
}

// ---------------------------------------------------------------------------
// Exported session resolution helper for use in other routes
// ---------------------------------------------------------------------------
export const COOKIE_NAME_EXPORT = COOKIE_NAME;
