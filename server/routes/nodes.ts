import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkerNode, NodeStatus, Priority, Provider } from '../../src/types.js';
import { resolveSession } from '../session.js';
import { mutateProject, isAdmin, requireTeamAccess } from '../db.js';
import {
  SERVER_ONLY_NODE_KEYS,
  validateNodeFields,
  PROVIDERS,
  NODE_TYPES,
  PRIORITIES,
  DESIRED_OUTPUTS,
} from './validate.js';

// Patchable fields — server controls id/teamId/graphId/status/output/history/progress/version
const PATCHABLE = new Set([
  'name', 'type', 'prompt', 'executor', 'context', 'owners',
  'inputs', 'position', 'priority', 'desiredOutput', 'templateId', 'inboxMeta', 'workspace',
]);

function defaultNode(overrides: Partial<WorkerNode> & { id: string; teamId: string; graphId: string; name: string }): WorkerNode {
  return {
    id: overrides.id,
    graphId: overrides.graphId,
    teamId: overrides.teamId,
    type: overrides.type ?? 'worker',
    name: overrides.name,
    status: 'draft' as NodeStatus,
    priority: (overrides.priority ?? 'normal') as Priority,
    progress: 0,
    prompt: overrides.prompt ?? { task: '', refinements: [], comments: [] },
    executor: overrides.executor ?? {
      provider: 'mock' as Provider,
      model: 'mock-v1',
      skills: [],
      tools: [],
      maxIterations: 5,
    },
    context: overrides.context ?? { files: [], extra: '' },
    owners: overrides.owners ?? { author: '', responsible: [] },
    inputs: overrides.inputs ?? [],
    output: { summary: '', results: [], commands: [], artifacts: [] },
    history: [],
    version: 1,
    position: overrides.position ?? { x: 0, y: 0 },
    templateId: overrides.templateId,
    inboxMeta: overrides.inboxMeta,
    desiredOutput: overrides.desiredOutput,
    workspace: overrides.workspace,
  };
}

/**
 * Cycle detection: checks only ENABLED edges so that a disabled feedback edge
 * does not falsely block a valid graph.
 */
function hasCycle(nodes: WorkerNode[], startId: string, inputs: { fromNodeId: string; enabled: boolean }[]): boolean {
  // Build adjacency: id -> [enabled predecessors]
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    adj.set(n.id, n.inputs.filter((i) => i.enabled).map((i) => i.fromNodeId));
  }
  // Override for the target node (use the proposed new inputs, enabled only)
  adj.set(startId, inputs.filter((i) => i.enabled).map((i) => i.fromNodeId));

  // DFS from startId following inputs (predecessors), detect if we reach startId again
  const visited = new Set<string>();
  function dfs(id: string): boolean {
    if (id === startId && visited.size > 0) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    for (const pred of adj.get(id) ?? []) {
      if (dfs(pred)) return true;
    }
    return false;
  }
  // Start from each enabled predecessor
  for (const inp of inputs) {
    if (!inp.enabled) continue;
    visited.clear();
    if (dfs(inp.fromNodeId)) return true;
  }
  return false;
}

export async function nodesRoutes(app: FastifyInstance): Promise<void> {
  const db: DatabaseSync = app.db;

  // ------------------------------------------------------------------
  // POST /api/nodes — create node
  // ------------------------------------------------------------------
  app.post('/api/nodes', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    // Null/non-object body is explicitly rejected
    if (req.body === null || req.body === undefined || typeof req.body !== 'object' || Array.isArray(req.body))
      return reply.status(400).send({ error: 'Request body must be a JSON object' });

    const body = req.body as Record<string, unknown>;

    // Reject any server-only keys on create (status, progress, output, history, id, version, inboxMeta)
    for (const k of SERVER_ONLY_NODE_KEYS) {
      if (k in body)
        return reply.status(400).send({ error: `Cannot set server-controlled field: ${k}` });
    }

    const { teamId, graphId, name } = body;

    if (typeof teamId !== 'string')
      return reply.status(400).send({ error: 'teamId is required' });
    if (typeof graphId !== 'string')
      return reply.status(400).send({ error: 'graphId is required' });
    if (typeof name !== 'string' || name.trim().length === 0)
      return reply.status(400).send({ error: 'name is required' });

    // Validate all supplied editable fields before touching the DB
    const valErr = validateNodeFields(body, true);
    if (valErr) return reply.status(400).send({ error: valErr });

    // Access check
    const admin = isAdmin(db, sess.userId, sess.orgId);
    if (!admin && !requireTeamAccess(db, sess.userId, sess.orgId, teamId, 'edit'))
      return reply.status(403).send({ error: 'Editor access required' });

    const nodeId = randomUUID();

    const { project, revision } = mutateProject(db, sess.orgId, (p) => {
      // Verify teamId belongs to this org
      if (!p.teams.some((t) => t.id === teamId))
        throw Object.assign(new Error('Team not found'), { statusCode: 404 });

      // Verify graphId exists and belongs to the same team
      const graph = p.graphContexts.find((g) => g.id === graphId);
      if (!graph) throw Object.assign(new Error('GraphContext not found'), { statusCode: 404 });
      if (graph.teamId !== teamId)
        throw Object.assign(new Error('GraphContext does not belong to specified team'), { statusCode: 400 });

      // Parse inputs (already validated above)
      const inputs: { fromNodeId: string; enabled: boolean }[] = Array.isArray(body.inputs)
        ? (body.inputs as { fromNodeId: string; enabled: boolean }[])
        : [];

      for (const inp of inputs) {
        const refNode = p.nodes.find((n) => n.id === inp.fromNodeId);
        if (!refNode)
          throw Object.assign(new Error(`Input node ${inp.fromNodeId} not found`), { statusCode: 400 });
        if (refNode.graphId !== graphId)
          throw Object.assign(new Error(`Input node ${inp.fromNodeId} is not in graph ${graphId}`), { statusCode: 400 });
      }

      // Cycle check (enabled edges only for new node)
      const nodesWithNew = [...p.nodes, { id: nodeId, inputs, graphId, teamId } as unknown as WorkerNode];
      if (inputs.some((i) => i.enabled) && hasCycle(nodesWithNew, nodeId, inputs))
        throw Object.assign(new Error('Input cycle detected'), { statusCode: 400 });

      // Build the new node — author is always set to the authenticated user's email
      const userRow = db.prepare('SELECT email FROM users WHERE id = ?').get(sess.userId) as
        | { email: string }
        | undefined;
      const authorEmail = userRow?.email ?? '';

      const ownersOverride = typeof body.owners === 'object' && body.owners !== null
        ? { ...(body.owners as Record<string, unknown>), author: authorEmail }
        : { author: authorEmail, responsible: [] };

      const newNode = defaultNode({
        id: nodeId,
        teamId,
        graphId,
        name: name.trim(),
        type: typeof body.type === 'string' ? body.type as WorkerNode['type'] : undefined,
        priority: typeof body.priority === 'string' ? body.priority as Priority : undefined,
        prompt: typeof body.prompt === 'object' && body.prompt !== null
          ? body.prompt as WorkerNode['prompt'] : undefined,
        executor: typeof body.executor === 'object' && body.executor !== null
          ? body.executor as WorkerNode['executor'] : undefined,
        context: typeof body.context === 'object' && body.context !== null
          ? body.context as WorkerNode['context'] : undefined,
        owners: ownersOverride as WorkerNode['owners'],
        inputs,
        position: typeof body.position === 'object' && body.position !== null
          ? body.position as WorkerNode['position'] : undefined,
        templateId: typeof body.templateId === 'string' ? body.templateId : undefined,
        desiredOutput: DESIRED_OUTPUTS.has(body.desiredOutput as string)
          ? body.desiredOutput as WorkerNode['desiredOutput'] : undefined,
        workspace: body.workspace != null && typeof body.workspace === 'object'
          ? body.workspace as WorkerNode['workspace'] : undefined,
      });

      return { ...p, nodes: [...p.nodes, newNode] };
    });

    const created = project.nodes.find((n) => n.id === nodeId);
    return reply.status(201).send({ ...created, revision });
  });

  // ------------------------------------------------------------------
  // PATCH /api/nodes/:id — update node
  // ------------------------------------------------------------------
  app.patch('/api/nodes/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    // Null/non-object body is explicitly rejected
    if (req.body === null || req.body === undefined || typeof req.body !== 'object' || Array.isArray(req.body))
      return reply.status(400).send({ error: 'Request body must be a JSON object' });

    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;

    // Reject server-only fields on patch too
    for (const k of SERVER_ONLY_NODE_KEYS) {
      if (k in body)
        return reply.status(400).send({ error: `Cannot set server-controlled field: ${k}` });
    }

    // Reject attempts to change ownership/provenance fields
    if (body.id !== undefined || body.teamId !== undefined || body.graphId !== undefined)
      return reply.status(400).send({ error: 'Cannot change id, teamId, or graphId' });

    // Validate all supplied editable fields before touching the DB
    const valErr = validateNodeFields(body, false);
    if (valErr) return reply.status(400).send({ error: valErr });

    const { project, revision } = mutateProject(db, sess.orgId, (p) => {
      const idx = p.nodes.findIndex((n) => n.id === id);
      if (idx === -1) throw Object.assign(new Error('Node not found'), { statusCode: 404 });

      const node = p.nodes[idx]!;

      // Access check
      if (!isAdmin(db, sess.userId, sess.orgId) &&
          !requireTeamAccess(db, sess.userId, sess.orgId, node.teamId, 'edit'))
        throw Object.assign(new Error('Editor access required'), { statusCode: 403 });

      // author cannot be changed via PATCH
      if (body.owners !== undefined) {
        const newOwners = body.owners as Record<string, unknown>;
        if (newOwners.author !== undefined && newOwners.author !== node.owners.author)
          throw Object.assign(new Error('Cannot change owners.author'), { statusCode: 400 });
      }

      // Apply only patchable fields
      const updated = { ...node };
      for (const key of Object.keys(body)) {
        if (!PATCHABLE.has(key)) continue;
        (updated as Record<string, unknown>)[key] = body[key];
      }

      // workspace: null means clear the override
      if ('workspace' in body) {
        if (body.workspace === null) {
          delete updated.workspace;
        } else if (typeof body.workspace === 'object') {
          updated.workspace = body.workspace as WorkerNode['workspace'];
        }
      }

      // Validate inputs if changed
      if (body.inputs !== undefined) {
        const inputs = body.inputs as { fromNodeId: string; enabled: boolean }[];
        for (const inp of inputs) {
          const refNode = p.nodes.find((n) => n.id === inp.fromNodeId);
          if (!refNode)
            throw Object.assign(new Error(`Input node ${inp.fromNodeId} not found`), { statusCode: 400 });
          if (refNode.graphId !== node.graphId)
            throw Object.assign(new Error(`Input node ${inp.fromNodeId} is not in the same graph`), { statusCode: 400 });
        }
        if (hasCycle(p.nodes, id, inputs))
          throw Object.assign(new Error('Input cycle detected'), { statusCode: 400 });
        updated.inputs = inputs;
      }

      updated.version = node.version + 1;
      const nodes = [...p.nodes];
      nodes[idx] = updated;
      return { ...p, nodes };
    });

    const updatedNode = project.nodes.find((n) => n.id === id);
    return reply.send({ ...updatedNode, revision });
  });

  // ------------------------------------------------------------------
  // DELETE /api/nodes/:id — remove node and references
  // ------------------------------------------------------------------
  app.delete('/api/nodes/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const sess = resolveSession(db, req, reply);
    if (!sess) return;

    const { id } = req.params as { id: string };

    mutateProject(db, sess.orgId, (p) => {
      const node = p.nodes.find((n) => n.id === id);
      if (!node) throw Object.assign(new Error('Node not found'), { statusCode: 404 });

      // Access check
      if (!isAdmin(db, sess.userId, sess.orgId) &&
          !requireTeamAccess(db, sess.userId, sess.orgId, node.teamId, 'edit'))
        throw Object.assign(new Error('Editor access required'), { statusCode: 403 });

      // Remove node and strip all references to it in inputs
      const nodes = p.nodes
        .filter((n) => n.id !== id)
        .map((n) => ({
          ...n,
          inputs: n.inputs.filter((inp) => inp.fromNodeId !== id),
        }));

      return { ...p, nodes };
    });

    return reply.status(204).send();
  });
}
