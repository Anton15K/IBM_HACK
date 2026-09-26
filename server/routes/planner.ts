import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { WorkerNode, ApiTokenUsage } from '../../src/types.js';
import { readProject, mutateProject, requireTeamAccess } from '../db.js';
import { resolveSession } from '../session.js';
import { fetchBoundedWithRetry, providerHttpError } from '../apiExecutor.js';
import type { ModelService } from '../models.js';

type PlanNode = { id: string; name: string; task: string; output: 'report' | 'patch'; dependsOn: string[] };
export type Plan = { nodes: PlanNode[] };
const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected a JSON object');
  return value as Record<string, unknown>;
}
export function validatePlan(value: unknown): Plan {
  const plan = object(value);
  if (Object.keys(plan).some(k => k !== 'nodes') || !Array.isArray(plan.nodes) || plan.nodes.length < 1 || plan.nodes.length > 8) return fail('Plan requires 1–8 nodes');
  const nodes = plan.nodes.map(value => {
    const n = object(value);
    if (Object.keys(n).some(k => !['id', 'name', 'task', 'output', 'dependsOn'].includes(k))) return fail('Unknown plan field');
    for (const [key, max] of [['id', 64], ['name', 120], ['task', 8000]] as const) {
      if (typeof n[key] !== 'string' || !n[key].trim() || n[key].length > max) return fail(`Invalid plan ${key}`);
    }
    if (!['report', 'patch'].includes(String(n.output)) || !Array.isArray(n.dependsOn) || n.dependsOn.length > 8 || n.dependsOn.some(x => typeof x !== 'string')) return fail('Invalid output or dependencies');
    return { id: n.id, name: n.name, task: n.task, output: n.output, dependsOn: [...new Set(n.dependsOn)] } as PlanNode;
  });
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (byId.size !== nodes.length) return fail('Duplicate plan node IDs');
  const complete = new Set<string>();
  function visit(id: string, path: Set<string>) {
    if (path.has(id)) return fail('Plan contains a cycle');
    if (complete.has(id)) return;
    const n = byId.get(id); if (!n) return fail('Unknown dependency');
    for (const dep of n.dependsOn) visit(dep, new Set([...path, id]));
    complete.add(id);
  }
  for (const n of nodes) visit(n.id, new Set());
  return { nodes };
}
export async function plannerRoutes(app: FastifyInstance, opts: { modelService: ModelService; fetchFn?: typeof fetch }) {
  function context(orgId: string, userId: string, graphId: string) {
    const current = readProject(app.db, orgId) ?? fail('Project not found', 404);
    const graph = current.project.graphContexts.find(g => g.id === graphId) ?? fail('Graph not found', 404);
    if (!requireTeamAccess(app.db, userId, orgId, graph.teamId, 'edit')) fail('Editor access required', 403);
    return { ...current, graph };
  }
  function connection(orgId: string, id: unknown) {
    if (typeof id !== 'string') return fail('connectionId required');
    return opts.modelService.list(orgId).find(c => c.id === id) ?? fail('Model connection not found', 404);
  }
  app.post('/api/graphs/:id/plan', async (req, reply) => {
    const session = resolveSession(app.db, req, reply); if (!session) return;
    const { id } = req.params as { id: string };
    const { project, revision, graph } = context(session.orgId, session.userId, id);
    const body = object(req.body);
    if (typeof body.intent !== 'string' || !body.intent.trim() || body.intent.length > 8000) return fail('Intent must contain 1–8000 characters');
    const descriptor = connection(session.orgId, body.connectionId);
    const conn = await opts.modelService.getApiKey(descriptor.id, session.orgId);
    if (!conn) return fail('Model connection not found', 404);
    const request = {
      model: conn.model, max_tokens: 2048,
      ...(new URL(conn.baseUrl).hostname === 'api.z.ai' ? { thinking: { type: 'disabled' } } : {}),
      messages: [
        { role: 'system', content: 'Propose a small coding workflow. Return only JSON {"nodes":[{"id":"unique-short-id","name":"Name","task":"Detailed English instructions","output":"report or patch","dependsOn":[]}]}. Use 1–8 nodes with an acyclic dependency graph. Tasks may inspect files and, in patch mode, edit files and run node --test. Report mode is read only. Do not add workspace, status or permission fields. This is a proposal for human acceptance; nothing runs now.' },
        { role: 'user', content: JSON.stringify({ intent: body.intent, goal: graph.goal, conventions: graph.conventions, workspace: graph.workspace, existing: project.nodes.filter(n => n.graphId === id).slice(0, 30).map(n => ({ name: n.name, task: n.prompt.task.slice(0, 500) })) }) },
      ],
    };
    let response;
    const planSignal = AbortSignal.timeout(30_000);
    try { response = await fetchBoundedWithRetry(conn.baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` }, body: JSON.stringify(request), signal: planSignal }, opts.fetchFn ?? fetch, planSignal); }
    catch { return fail('Planning request failed or timed out', 502); }
    if (!response.ok) return fail(providerHttpError(response.status, response.body), 502);
    let raw;
    try { raw = JSON.parse(response.body); } catch { return fail('Planning provider returned invalid JSON', 502); }
    const text = raw?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || raw?.choices?.[0]?.finish_reason === 'length') return fail('Planning provider returned incomplete content', 502);
    let plan;
    try { plan = validatePlan(JSON.parse(text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text)); }
    catch { return fail('Model proposal is invalid; no changes were applied', 502); }
    // Re-check permissions after the network call, before returning project context.
    context(session.orgId, session.userId, id);
    const u = raw.usage;
    const usage: ApiTokenUsage | undefined = u && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(k => typeof u[k] === 'number' && Number.isFinite(u[k]) && u[k] >= 0)
      ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens } : undefined;
    return { plan, revision, usage, model: conn.model };
  });
  app.post('/api/graphs/:id/apply-plan', async (req, reply) => {
    const session = resolveSession(app.db, req, reply); if (!session) return;
    const { id } = req.params as { id: string };
    const { graph } = context(session.orgId, session.userId, id);
    const body = object(req.body), descriptor = connection(session.orgId, body.connectionId), plan = validatePlan(body.plan);
    if (!Number.isInteger(body.expectedRevision)) return fail('expectedRevision required');
    const ids = new Map(plan.nodes.map(n => [n.id, randomUUID()]));
    const nodes: WorkerNode[] = plan.nodes.map((n, i) => ({
      id: ids.get(n.id)!, graphId: id, teamId: graph.teamId, type: 'worker', name: n.name, status: 'draft', priority: 'normal', progress: 0,
      prompt: { task: n.task, refinements: [], comments: [] },
      executor: { provider: 'api', model: descriptor.model, connectionId: descriptor.id, skills: [], tools: ['list_files', 'read_file', ...(n.output === 'patch' ? ['write_file', 'run_tests'] : [])], maxIterations: 8, maxOutputTokens: 1024, maxAttempts: 1 },
      desiredOutput: n.output, context: { files: [], extra: '' }, owners: { author: session.userId, responsible: [] },
      inputs: n.dependsOn.map(dep => ({ fromNodeId: ids.get(dep)!, enabled: true })), output: { summary: '', results: [], commands: [], artifacts: [] }, history: [], version: 1, position: { x: 80 + i * 280, y: 100 },
    }));
    const { revision } = mutateProject(app.db, session.orgId, p => {
      if (readProject(app.db, session.orgId)?.revision !== body.expectedRevision) return fail('Project changed; regenerate the plan before applying', 409);
      if (app.runtime.graphActive(session.orgId, id) || p.nodes.some(n => n.graphId === id && app.runtime.nodeActive(session.orgId, n.id))) return fail('Graph has active execution', 409);
      return { ...p, nodes: [...p.nodes, ...nodes] };
    });
    return reply.status(201).send({ nodes, revision });
  });
}
