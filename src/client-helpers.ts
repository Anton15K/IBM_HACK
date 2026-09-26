import type { Team, WorkerNode, GraphContext, NodeTemplate } from './types';
export interface Auth {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string };
  role: 'admin' | 'member';
  teamRoles: { teamId: string; role: 'editor' | 'viewer' }[];
}
export function effectiveRole(
  auth: Auth | null,
  teams: Team[],
  id: string,
): 'admin' | 'editor' | 'viewer' | null {
  if (auth?.role === 'admin') return 'admin';
  const visited = new Set<string>();
  let current: string | null = id;
  while (current && !visited.has(current)) {
    visited.add(current);
    const role = auth?.teamRoles.find((r) => r.teamId === current)?.role;
    if (role) return role;
    current = teams.find((t) => t.id === current)?.parentId ?? null;
  }
  return null;
}
export function ancestors(teams: Team[], id: string | null): Team[] {
  const result: Team[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const team = teams.find((t) => t.id === id);
    if (!team) break;
    result.unshift(team);
    id = team.parentId;
  }
  return result;
}
export const boardNodes = (
  nodes: WorkerNode[],
  teamId: string | null,
  graphId: string | null,
) => nodes.filter((n) => n.teamId === teamId && n.graphId === graphId);
// Nested definition fields merge independently; arrays replace as a whole.
export function mergePatch<T>(base: T, patch: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? mergePatch(
            (result[key] ?? {}) as Record<string, unknown>,
            value as Record<string, unknown>,
          )
        : value;
  }
  return result as T;
}
export const nodeDefinition = (
  patch: Partial<WorkerNode> & { workspace?: WorkerNode['workspace'] | null },
) => {
  const allowed = [
    'name',
    'type',
    'priority',
    'prompt',
    'executor',
    'context',
    'owners',
    'inputs',
    'position',
    'templateId',
    'desiredOutput',
    'workspace',
  ];
  return Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.includes(key)),
  );
};
export function templateDefinition(
  tpl: NodeTemplate,
  teamId: string,
  graph: GraphContext,
) {
  return {
    ...nodeDefinition(tpl.defaults),
    teamId,
    graphId: graph.id,
    name: tpl.name,
    templateId: tpl.id,
  };
}
export const handoffBody = (
  node: WorkerNode,
  targetTeamId: string,
  message: string,
  requestId: string,
  priority: WorkerNode['priority'],
) => ({
  targetTeamId,
  message,
  requestId,
  priority,
  ...(node.status === 'done' && node.currentAttemptId
    ? { sourceAttemptId: node.currentAttemptId }
    : {}),
});
