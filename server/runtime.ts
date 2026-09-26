import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GraphContext, WorkerNode, WorkspaceSnapshot } from '../src/types.js';
import { mutateProject, readProject } from './db.js';
import { assemblePrompt, executeTask, type ExecuteTaskInput, type ExecuteTaskResult, type IncomingEdge } from './executor.js';

export type Executor = (input: ExecuteTaskInput) => Promise<ExecuteTaskResult>;
type Output = WorkerNode['output'];
type RuntimeNode = WorkerNode & { currentAttemptId?: string };
export interface Attempt {
  id: string; orgId: string; runId?: string; nodeId: string; graphId: string; nodeVersion: number;
  node: WorkerNode; graph: GraphContext; assembledPrompt: string;
  incoming: IncomingEdge[]; startedAt: string; finishedAt?: string;
  status: 'running' | 'waiting' | 'done' | 'failed'; output?: Output; error?: string;
  taskId: string | null; sessionCosts: number | null;
  workspaceBefore: WorkspaceSnapshot | null; workspaceAfter: WorkspaceSnapshot | null;
  decision?: { decision: 'approve' | 'request_changes'; actor: string; feedback?: string; targetNodeId?: string; ts: string };
}
export interface Run {
  id: string; orgId: string; graphId: string; nodeIds: string[];
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'canceled';
  reworkRounds: number; paused: boolean; startedAt: string; finishedAt?: string;
}
export interface Receipt {
  id: string; orgId: string; requestId: string; sourceNodeId: string; sourceTeamId: string;
  recipientNodeId: string; recipientTeamId: string; sourceAttemptId?: string; createdAt: string;
}
const emptyOutput = (): Output => ({ summary: '', results: [], commands: [], artifacts: [] });
function fail(message: string, statusCode = 409): never { throw Object.assign(new Error(message), { statusCode }); }
const active = (run: Run) => run.status === 'running' || run.status === 'waiting';

export class Runtime {
  private jobs = new Map<string, { orgId: string; nodeId: string; controller: AbortController; promise: Promise<void> }>();
  private closing = false;
  private lastFinishedAt = 0;
  constructor(private db: DatabaseSync, private executor: Executor = executeTask) {
    db.exec(`CREATE TABLE IF NOT EXISTS execution_runs (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, graphId TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_attempts (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, nodeId TEXT NOT NULL, graphId TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_handoffs (id TEXT PRIMARY KEY, orgId TEXT NOT NULL, sourceNodeId TEXT NOT NULL, requestId TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(orgId,sourceNodeId,requestId));`);
    const rows = db.prepare('SELECT payload FROM execution_attempts').all() as { payload: string }[];
    for (const row of rows) {
      const a = JSON.parse(row.payload) as Attempt;
      this.lastFinishedAt = Math.max(this.lastFinishedAt, Date.parse(a.finishedAt ?? a.startedAt));
      if (a.status === 'running' || a.status === 'waiting') this.finish(a, undefined, 'Interrupted by server restart');
    }
    for (const row of db.prepare('SELECT payload FROM execution_runs').all() as { payload: string }[]) {
      const run = JSON.parse(row.payload) as Run;
      if (active(run)) { run.status = 'failed'; run.finishedAt = new Date().toISOString(); this.saveRun(run); }
    }
  }
  private project(orgId: string) { return readProject(this.db, orgId)?.project ?? fail('Project not found', 404); }
  node(orgId: string, id: string): RuntimeNode { return this.project(orgId).nodes.find(n => n.id === id) ?? fail('Node not found', 404); }
  graph(orgId: string, id: string) { return this.project(orgId).graphContexts.find(g => g.id === id) ?? fail('Graph not found', 404); }
  attempts(orgId: string, nodeId: string): Attempt[] {
    return (this.db.prepare('SELECT payload FROM execution_attempts WHERE orgId=? AND nodeId=? ORDER BY rowid').all(orgId, nodeId) as { payload: string }[]).map(r => JSON.parse(r.payload));
  }
  private attempt(orgId: string, id: string): Attempt | undefined {
    const row = this.db.prepare('SELECT payload FROM execution_attempts WHERE orgId=? AND id=?').get(orgId, id) as { payload: string } | undefined;
    return row && JSON.parse(row.payload);
  }
  latestRun(orgId: string, graphId: string): Run | null {
    const row = this.db.prepare('SELECT payload FROM execution_runs WHERE orgId=? AND graphId=? ORDER BY rowid DESC LIMIT 1').get(orgId, graphId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  graphActive(orgId: string, graphId: string): boolean { const r = this.latestRun(orgId, graphId); return !!r && active(r); }
  nodeActive(orgId: string, nodeId: string): boolean { const n = this.node(orgId, nodeId); return [...this.jobs.values()].some(j => j.orgId === orgId && j.nodeId === nodeId) || !!n.currentAttemptId && ['running', 'waiting'].includes(this.attempt(orgId, n.currentAttemptId)?.status ?? ''); }
  private saveAttempt(a: Attempt) {
    this.db.prepare('INSERT INTO execution_attempts(id,orgId,nodeId,graphId,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(a.id, a.orgId, a.nodeId, a.graphId, JSON.stringify(a));
  }
  private saveRun(r: Run) {
    this.db.prepare('INSERT INTO execution_runs(id,orgId,graphId,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(r.id, r.orgId, r.graphId, JSON.stringify(r));
  }
  private updateNode(orgId: string, nodeId: string, fn: (node: RuntimeNode) => RuntimeNode) {
    mutateProject(this.db, orgId, p => ({ ...p, nodes: p.nodes.map(n => n.id === nodeId ? fn(n) : n) }));
  }
  private incoming(orgId: string, node: WorkerNode): IncomingEdge[] | null {
    const p = this.project(orgId);
    const incoming: IncomingEdge[] = [];
    for (const edge of node.inputs.filter(i => i.enabled)) {
      const source = p.nodes.find(n => n.id === edge.fromNodeId) as RuntimeNode | undefined;
      if (!source || source.graphId !== node.graphId || source.status !== 'done') return null;
      const attempt = source.currentAttemptId ? this.attempt(orgId, source.currentAttemptId) : this.attempts(orgId, source.id).filter(a => a.status === 'done').at(-1);
      if (!attempt || attempt.status !== 'done') return null;
      incoming.push({ fromNodeId: source.id, attemptId: attempt.id, ...attempt.output ?? emptyOutput(), output: attempt.output ?? emptyOutput(), workspaceAfter: attempt.workspaceAfter, finishedAt: attempt.finishedAt });
      if (attempt.node.type === 'gate') incoming.push(...attempt.incoming);
    }
    const meta = node.inboxMeta;
    if (meta) incoming.push({ fromNodeId: meta.sourceNodeId, attemptId: meta.sourceAttemptId, ...meta.sourceOutput ?? emptyOutput(), output: meta.sourceOutput ?? emptyOutput(), workspaceAfter: null });
    return incoming.filter((edge, index) => incoming.findIndex(i => i.attemptId === edge.attemptId && i.fromNodeId === edge.fromNodeId) === index);
  }
  runNode(orgId: string, nodeId: string): Attempt {
    const node = this.node(orgId, nodeId);
    if (this.nodeActive(orgId, nodeId)) fail('Node already has an active attempt');
    if (this.graphActive(orgId, node.graphId)) fail('Graph run controls this node');
    const incoming = this.incoming(orgId, node);
    if (!incoming) fail('Dependencies must have successful attempts');
    const dependents = this.dependentNodes(orgId, node);
    if (dependents.some(n => this.nodeActive(orgId, n.id)))
      fail('A dependent task is active; finish or cancel it before rerunning this node');
    const attempt = this.dispatch(orgId, node, incoming);
    const invalidated = new Set(dependents.map(n => n.id));
    if (invalidated.size) mutateProject(this.db, orgId, p => ({
      ...p, nodes: p.nodes.map(n => invalidated.has(n.id)
        ? { ...n, status: 'blocked', progress: 0 } : n),
    }));
    return attempt;
  }
  private dependentNodes(orgId: string, source: WorkerNode): WorkerNode[] {
    const nodes = this.project(orgId).nodes.filter(n => n.graphId === source.graphId);
    const affected = new Set([source.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (!affected.has(node.id) && node.inputs.some(i => i.enabled && affected.has(i.fromNodeId))) {
          affected.add(node.id); changed = true;
        }
      }
    }
    return nodes.filter(n => n.id !== source.id && affected.has(n.id));
  }
  runGraph(orgId: string, graphId: string): Run {
    this.graph(orgId, graphId);
    if (this.graphActive(orgId, graphId)) fail('Graph already has an active run');
    const nodes = this.project(orgId).nodes.filter(n => n.graphId === graphId);
    if (nodes.some(n => this.nodeActive(orgId, n.id))) fail('Graph has an active node attempt');
    const run: Run = { id: randomUUID(), orgId, graphId, nodeIds: nodes.map(n => n.id), status: 'running', reworkRounds: 0, paused: false, startedAt: new Date().toISOString() };
    this.saveRun(run);
    this.wake(run);
    return this.latestRun(orgId, graphId)!;
  }
  private attemptCount(orgId: string, node: WorkerNode, runId?: string): number {
    const attempts = this.attempts(orgId, node.id).filter(a => a.node.type === 'worker');
    if (runId) return attempts.filter(a => a.runId === runId).length;
    let failures = 0;
    for (const a of attempts.reverse()) {
      if (a.runId || a.nodeVersion !== node.version || a.status === 'done') break;
      failures++;
    }
    return failures;
  }
  private checkpoint(a: Attempt, repositoryPath: string): WorkspaceSnapshot | undefined {
    const attempts = (this.db.prepare('SELECT payload FROM execution_attempts WHERE orgId=? AND graphId=?').all(a.orgId, a.graphId) as { payload: string }[]).map(row => JSON.parse(row.payload) as Attempt);
    // The graph owns cumulative worktree edits, while dependency results remain pinned.
    const completed = attempts.filter(p => p.node.type === 'worker' && p.status === 'done' && p.workspaceAfter?.repositoryPath === repositoryPath).sort((x, y) => (y.finishedAt ?? '').localeCompare(x.finishedAt ?? ''))[0];
    if (completed?.workspaceAfter) return completed.workspaceAfter;
    const incoming = a.incoming.filter(i => i.workspaceAfter?.repositoryPath === repositoryPath).sort((x, y) => (y.finishedAt ?? '').localeCompare(x.finishedAt ?? ''))[0];
    if (incoming?.workspaceAfter) return incoming.workspaceAfter;
    // A first failed/canceled execution cannot silently authorize its own edits.
    return attempts.filter(p => p.id !== a.id && p.node.type === 'worker' && p.workspaceBefore?.repositoryPath === repositoryPath).sort((x, y) => x.startedAt.localeCompare(y.startedAt))[0]?.workspaceBefore ?? undefined;
  }
  private dispatch(orgId: string, node: WorkerNode, incoming: IncomingEdge[], runId?: string): Attempt {
    if (this.closing) fail('Runtime is closing');
    if (node.type === 'inbox') fail('Convert inbox to worker before execution');
    if (node.type === 'worker' && this.attemptCount(orgId, node, runId) >= (node.executor.maxAttempts ?? 3)) fail('Node attempt limit exhausted');
    const graph = this.graph(orgId, node.graphId);
    const a: Attempt = { id: randomUUID(), orgId, runId, nodeId: node.id, graphId: node.graphId, nodeVersion: node.version, node: structuredClone(node), graph: structuredClone(graph), incoming: structuredClone(incoming), assembledPrompt: assemblePrompt(node, graph, incoming, null), startedAt: new Date().toISOString(), status: node.type === 'gate' ? 'waiting' : 'running', taskId: null, sessionCosts: null, workspaceBefore: null, workspaceAfter: null };
    this.saveAttempt(a);
    this.updateNode(orgId, node.id, n => ({ ...n, currentAttemptId: a.id, status: node.type === 'gate' ? 'needs_approval' : 'queued', progress: 0 }));
    if (node.type === 'gate') return a;
    const controller = new AbortController();
    // The microtask ensures the job is registered before a synchronous fake executor settles.
    const promise = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) throw new Error('Canceled');
        const result = await this.executor({ node: a.node, graph: a.graph, incoming: a.incoming, assembledPrompt: a.assembledPrompt, signal: controller.signal, attemptId: a.id,
          onPrepared: ({ workspaceBefore, assembledPrompt }) => {
            if (controller.signal.aborted || a.status !== 'running') fail('Attempt canceled');
            a.workspaceBefore = workspaceBefore; a.assembledPrompt = assembledPrompt; this.saveAttempt(a);
            this.updateNode(orgId, node.id, n => n.currentAttemptId === a.id ? { ...n, status: 'running' } : n);
            const prior = workspaceBefore ? this.checkpoint(a, workspaceBefore.repositoryPath) : undefined;
            if (prior && prior.fingerprint !== workspaceBefore?.fingerprint) fail('Workspace drift from graph checkpoint; review and restore the worktree before retrying');
          } });
        this.finish(a, result, controller.signal.aborted ? 'Canceled' : undefined);
      } catch (error) { this.finish(a, undefined, error instanceof Error ? error.message : 'Execution failed'); }
      finally { this.jobs.delete(a.id); if (a.runId && !this.closing) { const run = this.latestRun(orgId, a.graphId); if (run?.id === a.runId) this.wake(run); } }
    });
    this.jobs.set(a.id, { orgId, nodeId: node.id, controller, promise });
    return a;
  }
  private finish(a: Attempt, result?: ExecuteTaskResult, error?: string) {
    const persisted = this.attempt(a.orgId, a.id);
    if (persisted && (persisted.status === 'done' || persisted.status === 'failed')) Object.assign(a, persisted);
    if (a.status === 'done' || a.status === 'failed') {
      if (result) {
        a.taskId = result.taskId; a.sessionCosts = result.sessionCosts;
        a.workspaceBefore = result.workspaceBefore ?? a.workspaceBefore; a.workspaceAfter = result.workspaceAfter ?? a.workspaceAfter;
        this.saveAttempt(a);
        this.updateNode(a.orgId, a.nodeId, n => ({ ...n, history: n.history.map(h => h.attemptId === a.id ? { ...h, taskId: a.taskId, sessionCosts: a.sessionCosts, workspaceBefore: a.workspaceBefore?.fingerprint, workspaceAfter: a.workspaceAfter?.fingerprint } : h) }));
      }
      return;
    }
    a.status = !error && (result?.status === 'done' || (a.node.type === 'gate' && a.output)) ? 'done' : 'failed';
    this.lastFinishedAt = Math.max(Date.now(), this.lastFinishedAt + 1);
    a.finishedAt = new Date(this.lastFinishedAt).toISOString();
    a.error = error ?? (result?.status === 'failed' ? result.error : undefined);
    if (result) { a.taskId = result.taskId; a.sessionCosts = result.sessionCosts; a.workspaceBefore = result.workspaceBefore ?? a.workspaceBefore; a.workspaceAfter = result.workspaceAfter; if (result.status === 'done') a.output = result.output; }
    this.saveAttempt(a);
    this.updateNode(a.orgId, a.nodeId, n => n.currentAttemptId !== a.id ? n : ({ ...n, status: a.status === 'done' ? 'done' : 'failed', progress: a.status === 'done' ? 100 : 0, output: a.output ?? n.output,
      history: [...n.history, { ts: a.finishedAt!, provider: a.node.executor.provider, model: a.node.executor.model, status: a.status === 'done' ? 'done' : 'failed', summary: a.output?.summary ?? a.error ?? '', durationMs: Date.parse(a.finishedAt!) - Date.parse(a.startedAt), attemptId: a.id, taskId: a.taskId, sessionCosts: a.sessionCosts, workspaceBefore: a.workspaceBefore?.fingerprint, workspaceAfter: a.workspaceAfter?.fingerprint }] }));
  }
  private wake(run: Run) {
    if (!active(run) || run.paused || this.closing) return;
    let nodes = this.project(run.orgId).nodes.filter(n => run.nodeIds.includes(n.id));
    for (const node of nodes) {
      if (['done', 'failed', 'queued', 'running', 'needs_approval'].includes(node.status)) continue;
      const incoming = this.incoming(run.orgId, node);
      if (!incoming || node.type === 'inbox') { this.updateNode(run.orgId, node.id, n => ({ ...n, status: 'blocked', progress: 0 })); continue; }
      try { this.dispatch(run.orgId, node, incoming, run.id); }
      catch (error) { this.updateNode(run.orgId, node.id, n => ({ ...n, status: 'failed', progress: 0 })); }
    }
    nodes = this.project(run.orgId).nodes.filter(n => run.nodeIds.includes(n.id));
    run.status = nodes.some(n => n.status === 'running' || n.status === 'queued') ? 'running' : nodes.every(n => n.status === 'done') ? 'completed' : nodes.some(n => n.status === 'needs_approval' || (n.type === 'inbox' && this.incoming(run.orgId, n))) ? 'waiting' : nodes.some(n => n.status === 'failed') ? 'failed' : 'waiting';
    if (!active(run)) run.finishedAt = new Date().toISOString();
    this.saveRun(run);
  }
  decision(orgId: string, nodeId: string, attemptId: string, decision: 'approve' | 'request_changes', actor: string, targetNodeId?: string, feedback?: string) {
    const node = this.node(orgId, nodeId), a = this.attempt(orgId, attemptId);
    if (node.type !== 'gate' || node.currentAttemptId !== attemptId || !a || a.status !== 'waiting') fail('Stale or duplicate gate decision');
    const incoming = this.incoming(orgId, node);
    if (!incoming || JSON.stringify(incoming.map(i => i.attemptId)) !== JSON.stringify(a.incoming.map(i => i.attemptId))) fail('Gate dependencies changed');
    const run = a.runId ? this.latestRun(orgId, node.graphId) : null;
    if (decision === 'approve') {
      a.decision = { decision, actor, feedback, ts: new Date().toISOString() };
      a.output = {
        summary: [...a.incoming.map(i => i.summary).filter(Boolean), feedback ? `Approved: ${feedback}` : 'Approved'].join('\n'),
        results: [...new Set(a.incoming.flatMap(i => i.results))],
        commands: [...new Set(a.incoming.flatMap(i => i.commands))],
        artifacts: [...new Set(a.incoming.flatMap(i => i.artifacts))],
      };
      a.workspaceAfter = a.incoming.filter(i => i.workspaceAfter).sort((x, y) => (y.finishedAt ?? '').localeCompare(x.finishedAt ?? ''))[0]?.workspaceAfter ?? null;
      this.finish(a, undefined);
      if (run) this.wake(run);
    } else {
      const target = targetNodeId ? this.node(orgId, targetNodeId) : undefined;
      if (!target || target.type !== 'worker' || !node.inputs.some(i => i.enabled && i.fromNodeId === target.id)) fail('Rework target must be an enabled immediate upstream worker', 400);
      if (!run || !active(run)) fail('Rework requires an active graph run');
      if (run.reworkRounds >= 3) fail('Graph rework limit exhausted');
      if (this.attemptCount(orgId, target, run.id) >= (target.executor.maxAttempts ?? 3)) fail('Node attempt limit exhausted');
      a.decision = { decision, actor, feedback, targetNodeId, ts: new Date().toISOString() }; this.saveAttempt(a);
      run.reworkRounds++; run.paused = true; run.status = 'waiting'; this.saveRun(run);
      for (const n of [target, ...this.dependentNodes(orgId, target)]) {
        if (this.nodeActive(orgId, n.id)) this.cancelNode(orgId, n.id, false);
        this.updateNode(orgId, n.id, current => ({ ...current, status: n.id === target.id ? 'rework' : 'blocked', progress: 0, ...(n.id === target.id ? { prompt: { ...current.prompt, refinements: [...current.prompt.refinements, { ts: new Date().toISOString(), author: actor, text: feedback ?? 'Changes requested' }] }, version: current.version + 1 } : {}) }));
      }
    }
    return this.attempt(orgId, attemptId)!;
  }
  resume(orgId: string, graphId: string): Run {
    const run = this.latestRun(orgId, graphId);
    if (!run || !active(run) || !run.paused) fail('Graph is not awaiting rework resume');
    if ([...this.jobs.entries()].some(([id, job]) => job.orgId === orgId && run.nodeIds.includes(job.nodeId) && this.attempt(orgId, id)?.status === 'failed')) fail('Canceled executors are still stopping; resume after cleanup');
    run.paused = false; run.status = 'running'; this.saveRun(run); this.wake(run);
    return this.latestRun(orgId, graphId)!;
  }
  cancelNode(orgId: string, nodeId: string, wake = true) {
    const node = this.node(orgId, nodeId);
    const a = node.currentAttemptId ? this.attempt(orgId, node.currentAttemptId) : undefined;
    if (a && this.jobs.has(a.id) && !['running', 'waiting'].includes(a.status)) { this.jobs.get(a.id)!.controller.abort(); return node; }
    if (!a || !['running', 'waiting'].includes(a.status)) fail('Node has no active attempt');
    this.jobs.get(a.id)?.controller.abort(); this.finish(a, undefined, 'Canceled');
    if (wake && a.runId) { const run = this.latestRun(orgId, node.graphId); if (run) this.wake(run); }
    return this.node(orgId, nodeId);
  }
  cancelGraph(orgId: string, graphId: string) {
    const run = this.latestRun(orgId, graphId);
    if (!run || !active(run)) fail('Graph has no active run');
    run.status = 'canceled'; run.finishedAt = new Date().toISOString(); this.saveRun(run);
    for (const id of run.nodeIds) {
      if (this.nodeActive(orgId, id)) this.cancelNode(orgId, id, false);
      else if (!['done', 'failed'].includes(this.node(orgId, id).status)) this.updateNode(orgId, id, n => ({ ...n, status: 'failed', progress: 0 }));
    }
    return run;
  }
  handoff(orgId: string, sourceId: string, actor: string, body: { targetTeamId: string; requestId: string; message: string; sourceAttemptId?: string; priority?: WorkerNode['priority'] }): Receipt {
    const source = this.node(orgId, sourceId), p = this.project(orgId);
    const previous = this.db.prepare('SELECT payload FROM execution_handoffs WHERE orgId=? AND sourceNodeId=? AND requestId=?').get(orgId, sourceId, body.requestId) as { payload: string } | undefined;
    if (previous) return JSON.parse(previous.payload);
    if (!p.teams.some(t => t.id === body.targetTeamId)) fail('Target team not found', 404);
    const graph = p.graphContexts.find(g => g.teamId === body.targetTeamId) ?? fail('Target team has no graph', 400);
    if (this.graphActive(orgId, graph.id)) fail('Cannot add handoff inbox during an active target graph run');
    const a = body.sourceAttemptId ? this.attempt(orgId, body.sourceAttemptId) : this.attempts(orgId, sourceId).filter(a => a.status === 'done').at(-1);
    if (body.sourceAttemptId && (!a || a.nodeId !== sourceId || a.status !== 'done')) fail('Source attempt must be successful and belong to source node', 400);
    const receipt: Receipt = { id: randomUUID(), orgId, requestId: body.requestId, sourceNodeId: sourceId, sourceTeamId: source.teamId, recipientNodeId: randomUUID(), recipientTeamId: body.targetTeamId, sourceAttemptId: a?.id, createdAt: new Date().toISOString() };
    const inbox: WorkerNode = { id: receipt.recipientNodeId, graphId: graph.id, teamId: graph.teamId, name: source.name, type: 'inbox', status: 'draft', priority: body.priority ?? 'normal', progress: 0, prompt: { task: body.message, refinements: [], comments: [] }, executor: { provider: 'mock', model: 'mock-v1', skills: [], tools: [], maxIterations: 5 }, context: { files: [], extra: '' }, owners: { author: actor, responsible: [] }, inputs: [], output: emptyOutput(), history: [], version: 1, position: { x: 0, y: 0 }, inboxMeta: { sourceNodeId: sourceId, sourceTeamId: source.teamId, sourceAttemptId: a?.id, message: body.message, sourceOutput: a?.output ?? emptyOutput() } };
    mutateProject(this.db, orgId, project => {
      this.db.prepare('INSERT INTO execution_handoffs(id,orgId,sourceNodeId,requestId,payload) VALUES(?,?,?,?,?)').run(receipt.id, orgId, sourceId, body.requestId, JSON.stringify(receipt));
      return { ...project, nodes: [...project.nodes, inbox] };
    });
    return receipt;
  }
  handoffs(orgId: string, sourceId: string) {
    return (this.db.prepare('SELECT payload FROM execution_handoffs WHERE orgId=? AND sourceNodeId=?').all(orgId, sourceId) as { payload: string }[]).map(row => {
      const receipt = JSON.parse(row.payload) as Receipt;
      const node = this.project(orgId).nodes.find(n => n.id === receipt.recipientNodeId) as RuntimeNode | undefined;
      return { ...receipt, recipient: node ? { id: node.id, name: node.name, status: node.status, progress: node.progress, summary: node.output.summary, attemptId: node.currentAttemptId } : null };
    });
  }
  async close() {
    this.closing = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(j => j.promise));
    for (const row of this.db.prepare('SELECT payload FROM execution_attempts').all() as { payload: string }[]) { const a = JSON.parse(row.payload) as Attempt; if (a.status === 'running' || a.status === 'waiting') this.finish(a, undefined, 'Canceled'); }
    for (const row of this.db.prepare('SELECT payload FROM execution_runs').all() as { payload: string }[]) { const run = JSON.parse(row.payload) as Run; if (active(run)) this.cancelGraph(run.orgId, run.graphId); }
  }
}
