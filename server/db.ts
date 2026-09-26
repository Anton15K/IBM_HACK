import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Project, Team, WorkerNode, GraphContext, NodeTemplate } from '../src/types.js';

// ---------------------------------------------------------------------------
// Built-in templates (copied from seed, isBuiltIn=true)
// ---------------------------------------------------------------------------
export const BUILTIN_TEMPLATES: NodeTemplate[] = [
  {
    id: 'tpl-code-review',
    name: 'Code Review',
    description: 'Review code for quality, security, and best practices',
    isBuiltIn: true,
    defaults: {
      type: 'gate',
      priority: 'normal',
      prompt: {
        task: 'Review the provided code changes. Check for correctness, security issues, performance, code style, and test coverage. Approve or request changes.',
        refinements: [],
        comments: [],
      },
      executor: { provider: 'bob', model: 'bob-4', skills: ['code-review'], tools: ['code-editor'], maxIterations: 3 },
      context: { files: [], extra: '' },
    },
  },
  {
    id: 'tpl-write-tests',
    name: 'Write Tests',
    description: 'Generate comprehensive tests for a module',
    isBuiltIn: true,
    defaults: {
      type: 'worker',
      priority: 'normal',
      prompt: {
        task: 'Write comprehensive unit and integration tests. Aim for >80% coverage. Include happy path, edge cases, and error scenarios.',
        refinements: [],
        comments: [],
      },
      executor: { provider: 'bob', model: 'bob-4', skills: ['testing'], tools: ['code-editor', 'terminal'], maxIterations: 5 },
      context: { files: [], extra: '' },
    },
  },
  {
    id: 'tpl-fix-bug',
    name: 'Fix Bug',
    description: 'Diagnose and fix a reported bug',
    isBuiltIn: true,
    defaults: {
      type: 'worker',
      priority: 'high',
      prompt: {
        task: 'Diagnose the reported bug. Find root cause, implement fix, ensure no regression. Document the fix in the commit message.',
        refinements: [],
        comments: [],
      },
      executor: { provider: 'bob', model: 'bob-4', skills: ['debugging', 'backend'], tools: ['code-editor', 'terminal', 'debugger'], maxIterations: 8 },
      context: { files: [], extra: '' },
    },
  },
  {
    id: 'tpl-investigate',
    name: 'Investigate',
    description: 'Research and document findings on a technical topic',
    isBuiltIn: true,
    defaults: {
      type: 'inbox',
      priority: 'normal',
      prompt: {
        task: 'Research the topic thoroughly. Compare at least 3 approaches. Document findings, trade-offs, and a clear recommendation.',
        refinements: [],
        comments: [],
      },
      executor: { provider: 'mock', model: 'mock-v1', skills: ['research'], tools: ['web-search'], maxIterations: 3 },
      context: { files: [], extra: '' },
    },
  },
];

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------
export type OrgRole = 'admin' | 'member';
export type TeamRole = 'editor' | 'viewer';

export interface DbUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  salt: string;
}

export interface DbOrg {
  id: string;
  name: string;
}

export interface DbOrgMembership {
  userId: string;
  orgId: string;
  role: OrgRole;
}

export interface DbTeamMembership {
  userId: string;
  orgId: string;
  teamId: string;
  role: TeamRole;
}

export interface DbSession {
  tokenHash: string;
  userId: string;
  orgId: string;
  expiresAt: number; // unix ms
}

export interface DbProject {
  orgId: string;
  revision: number;
  data: string; // JSON
}

// ---------------------------------------------------------------------------
// Repository helpers
// ---------------------------------------------------------------------------
export interface UserMembership {
  user: DbUser;
  orgId: string;
  orgRole: OrgRole;
  teamMemberships: DbTeamMembership[];
}

// ---------------------------------------------------------------------------
// Open / initialise database
// ---------------------------------------------------------------------------
export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  applySchema(db);
  return db;
}

function applySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      email        TEXT UNIQUE NOT NULL,
      name         TEXT NOT NULL,
      passwordHash TEXT NOT NULL,
      salt         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organizations (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS org_memberships (
      userId TEXT NOT NULL,
      orgId  TEXT NOT NULL,
      role   TEXT NOT NULL CHECK(role IN ('admin','member')),
      PRIMARY KEY (userId, orgId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (orgId)  REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS team_memberships (
      userId TEXT NOT NULL,
      orgId  TEXT NOT NULL,
      teamId TEXT NOT NULL,
      role   TEXT NOT NULL CHECK(role IN ('editor','viewer')),
      PRIMARY KEY (userId, orgId, teamId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (orgId)  REFERENCES organizations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      tokenHash TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      orgId     TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS projects (
      orgId    TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      data     TEXT NOT NULL,
      FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
    );
  `);
}

// ---------------------------------------------------------------------------
// Project read/mutate
// ---------------------------------------------------------------------------
export function readProject(db: DatabaseSync, orgId: string): { project: Project; revision: number } | null {
  const row = db.prepare('SELECT data, revision FROM projects WHERE orgId = ?').get(orgId) as
    | { data: string; revision: number }
    | undefined;
  if (!row) return null;
  return { project: JSON.parse(row.data) as Project, revision: row.revision };
}

export function mutateProject(
  db: DatabaseSync,
  orgId: string,
  updater: (p: Project) => Project,
): { project: Project; revision: number } {
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT data, revision FROM projects WHERE orgId = ?').get(orgId) as
      | { data: string; revision: number }
      | undefined;
    if (!row) throw new Error(`No project for org ${orgId}`);
    const current = JSON.parse(row.data) as Project;
    const updated = updater(current);
    const newRev = row.revision + 1;
    db.prepare('UPDATE projects SET data = ?, revision = ? WHERE orgId = ?').run(
      JSON.stringify(updated),
      newRev,
      orgId,
    );
    db.exec('COMMIT');
    return { project: updated, revision: newRev };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Org/membership helpers
// ---------------------------------------------------------------------------
export function getUserMembership(db: DatabaseSync, userId: string, orgId: string): UserMembership | null {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as DbUser | undefined;
  if (!user) return null;
  const orgMem = db
    .prepare('SELECT * FROM org_memberships WHERE userId = ? AND orgId = ?')
    .get(userId, orgId) as DbOrgMembership | undefined;
  if (!orgMem) return null;
  const teamMems = db
    .prepare('SELECT * FROM team_memberships WHERE userId = ? AND orgId = ?')
    .all(userId, orgId) as unknown as DbTeamMembership[];
  return { user, orgId, orgRole: orgMem.role, teamMemberships: teamMems };
}

export function isAdmin(db: DatabaseSync, userId: string, orgId: string): boolean {
  const row = db
    .prepare("SELECT role FROM org_memberships WHERE userId = ? AND orgId = ? AND role = 'admin'")
    .get(userId, orgId);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Access helpers — resolve effective team role considering ancestor inheritance
// ---------------------------------------------------------------------------
export function requireTeamAccess(
  db: DatabaseSync,
  userId: string,
  orgId: string,
  teamId: string,
  required: 'read' | 'edit',
): boolean {
  // Admins have full access
  if (isAdmin(db, userId, orgId)) return true;

  const projectRow = db.prepare('SELECT data FROM projects WHERE orgId = ?').get(orgId) as
    | { data: string }
    | undefined;
  if (!projectRow) return false;
  const project = JSON.parse(projectRow.data) as Project;

  // Build ancestor chain (nearest first)
  const teamMap = new Map(project.teams.map((t) => [t.id, t]));
  const ancestors: string[] = [];
  let cur: Team | undefined = teamMap.get(teamId);
  while (cur) {
    ancestors.push(cur.id);
    cur = cur.parentId ? teamMap.get(cur.parentId) : undefined;
  }

  // Find the most specific (nearest) explicit membership
  const teamMems = db
    .prepare('SELECT * FROM team_memberships WHERE userId = ? AND orgId = ? AND teamId IN (' + ancestors.map(() => '?').join(',') + ')')
    .all(userId, orgId, ...ancestors) as unknown as DbTeamMembership[];

  if (teamMems.length === 0) return false;

  // Pick the membership for the nearest ancestor
  const byTeam = new Map(teamMems.map((m) => [m.teamId, m]));
  let effectiveRole: TeamRole | null = null;
  for (const aid of ancestors) {
    const m = byTeam.get(aid);
    if (m) { effectiveRole = m.role; break; }
  }
  if (!effectiveRole) return false;

  if (required === 'read') return true; // viewer or editor
  return effectiveRole === 'editor';
}

// ---------------------------------------------------------------------------
// Org isolation check for a teamId
// ---------------------------------------------------------------------------
export function teamBelongsToOrg(db: DatabaseSync, teamId: string, orgId: string): boolean {
  const row = db.prepare('SELECT data FROM projects WHERE orgId = ?').get(orgId) as
    | { data: string }
    | undefined;
  if (!row) return false;
  const project = JSON.parse(row.data) as Project;
  return project.teams.some((t) => t.id === teamId);
}
