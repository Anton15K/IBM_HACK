import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Project, Team } from '../../src/types.js';
import { resolveSession } from '../session.js';
import { readProject, isAdmin, requireTeamAccess } from '../db.js';

// Build a filtered project view for the user:
// - Admin sees all
// - Others see only teams they have access to (via ancestor inheritance),
//   with ancestor labels preserved for navigation but those teams' nodes hidden
function filterProject(project: Project, userId: string, orgId: string, db: DatabaseSync): Project {
  if (isAdmin(db, userId, orgId)) return project;

  const teamMap = new Map(project.teams.map((t) => [t.id, t]));

  // For each team, check if user has read access (own or via ancestor)
  const accessibleTeamIds = new Set<string>();
  const navigationTeamIds = new Set<string>(); // ancestors of accessible teams

  for (const team of project.teams) {
    if (requireTeamAccess(db, userId, orgId, team.id, 'read')) {
      accessibleTeamIds.add(team.id);
      // Add ancestors for navigation
      let cur: Team | undefined = teamMap.get(team.id);
      while (cur?.parentId) {
        navigationTeamIds.add(cur.parentId);
        cur = teamMap.get(cur.parentId);
      }
    }
  }

  const visibleTeamIds = new Set([...accessibleTeamIds, ...navigationTeamIds]);

  const filteredTeams = project.teams
    .filter((t) => visibleTeamIds.has(t.id))
    .map((t) => {
      if (!accessibleTeamIds.has(t.id)) {
        // Navigation-only team: preserve structure but hide task label
        return { ...t, currentTaskLabel: undefined };
      }
      return t;
    });

  const filteredNodes = project.nodes.filter((n) => accessibleTeamIds.has(n.teamId));
  const filteredGraphs = project.graphContexts.filter((g) => accessibleTeamIds.has(g.teamId));

  return {
    ...project,
    teams: filteredTeams,
    nodes: filteredNodes,
    graphContexts: filteredGraphs,
  };
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  const db: DatabaseSync = app.db;

  // ------------------------------------------------------------------
  // GET /api/project — filtered project + revision
  // ------------------------------------------------------------------
  app.get('/api/project', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    const result = readProject(db, sess.orgId);
    if (!result) return reply.status(404).send({ error: 'Project not found' });

    const filtered = filterProject(result.project, sess.userId, sess.orgId, db);
    return reply.send({ ...filtered, revision: result.revision });
  });
}
