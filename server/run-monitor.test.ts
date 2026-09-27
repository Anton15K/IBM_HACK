import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import { hashToken } from './auth.js';
import type { ExecuteTaskInput, ExecuteTaskResult } from './executor.js';
import type { Project, RunMonitorResponse, WorkerNode } from '../src/types.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const output = { summary: 'fixture result', results: [], commands: [], artifacts: [] };
function node(id: string, inputs: string[] = [], type: WorkerNode['type'] = 'worker'): WorkerNode {
  return { id, teamId: 'team', graphId: 'graph', name: id, type, status: 'draft', priority: 'normal', progress: 0,
    prompt: { task: 'PRIVATE_PROMPT', refinements: [], comments: [] }, context: { files: [], extra: 'PRIVATE_CONTEXT' },
    executor: { provider: 'mock', model: 'mock', skills: [], tools: [], maxIterations: 1 },
    owners: { author: 'different-node-author@example.test', responsible: [] }, inputs: inputs.map(fromNodeId => ({ fromNodeId, enabled: true })),
    output, history: [], version: 1, position: { x: 0, y: 0 }, workspace: { path: '/PRIVATE_WORKSPACE', branch: 'main', ref: 'HEAD' } };
}
function fixture(nodes = [node('task')], dbPath = ':memory:') {
  const calls: ExecuteTaskInput[] = [];
  const pending = new Map<string, (value: ExecuteTaskResult) => void>();
  const app = buildApp({ dbPath, executor: async input => {
    calls.push(input);
    return new Promise(resolve => pending.set(input.attemptId!, resolve));
  } });
  const project: Project = { version: 1, nodes, templates: [],
    teams: [{ id: 'team', name: 'Visible team', kind: 'team', parentId: null, space: { x: 0, y: 0, w: 0, h: 0 } },
      { id: 'private-team', name: 'PRIVATE_TEAM', kind: 'team', parentId: null, space: { x: 0, y: 0, w: 0, h: 0 } }],
    graphContexts: [{ id: 'graph', name: 'Visible project', teamId: 'team', goal: '', repo: '', conventions: '' },
      { id: 'private-graph', name: 'PRIVATE_GRAPH', teamId: 'private-team', goal: '', repo: '', conventions: '' }] };
  app.db.prepare('INSERT INTO organizations(id,name) VALUES(?,?)').run('org', 'Organization');
  app.db.prepare('INSERT INTO projects(orgId,data) VALUES(?,?)').run('org', JSON.stringify(project));
  for (const role of ['editor', 'viewer', 'unassigned']) {
    app.db.prepare('INSERT INTO users(id,email,name,passwordHash,salt) VALUES(?,?,?,?,?)').run(role, `${role}@example.test`, `Launch ${role}`, '', '');
    app.db.prepare('INSERT INTO org_memberships(userId,orgId,role) VALUES(?,?,?)').run(role, 'org', 'member');
    if (role !== 'unassigned') app.db.prepare('INSERT INTO team_memberships(userId,orgId,teamId,role) VALUES(?,?,?,?)').run(role, 'org', 'team', role);
    app.db.prepare('INSERT INTO sessions(tokenHash,userId,orgId,expiresAt) VALUES(?,?,?,?)').run(hashToken(role), role, 'org', Date.now() + 100000);
  }
  const request = (method: 'GET' | 'POST', url: string, user = 'editor', payload?: object) => app.inject({ method, url, payload, cookies: { tw_session: user } });
  function finish(id: string) {
    const input = calls.filter(c => c.node.id === id).at(-1)!;
    pending.get(input.attemptId!)!({ status: 'done', output, summary: output.summary, simulated: true, taskId: null, sessionCosts: null,
      identity: { attemptId: input.attemptId!, nodeId: id, nodeVersion: input.node.version, graphId: input.graph.id, ts: new Date().toISOString() },
      meta: { provider: 'mock', model: 'mock', durationMs: 1, status: 'done', simulated: true, taskId: null, sessionCosts: null }, workspaceBefore: null, workspaceAfter: null });
    pending.delete(input.attemptId!);
  }
  async function close() { for (const input of calls) if (pending.has(input.attemptId!)) finish(input.node.id); await tick(); await app.close(); }
  return { app, calls, request, finish, close, project, monitor: async (user = 'editor') => (await request('GET', '/api/run-monitor', user)).json() as RunMonitorResponse };
}

test('monitor is session/org/team scoped and never exports task details', async t => {
  const privateNode = { ...node('PRIVATE_NODE'), graphId: 'private-graph', teamId: 'private-team' };
  const f = fixture([node('task'), privateNode]); t.after(f.close);
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/run-monitor' })).statusCode, 401);
  f.app.runtime.runNode('org', privateNode.id);
  f.app.db.prepare('INSERT INTO organizations(id,name) VALUES(?,?)').run('foreign-org', 'FOREIGN_ORG');
  f.app.db.prepare('INSERT INTO projects(orgId,data) VALUES(?,?)').run('foreign-org', JSON.stringify({ ...f.project, nodes: [node('FOREIGN_TASK')] }));
  f.app.runtime.runNode('foreign-org', 'FOREIGN_TASK');
  await f.request('POST', '/api/nodes/task/run'); await tick();
  const result = await f.monitor();
  assert.deepEqual(result.items.map(i => i.name), ['task']);
  assert.equal(result.items[0].canCancel, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|FOREIGN_|"prompt"|"workspace"|"context"|"assembledPrompt"/);
  assert.deepEqual((await f.monitor('unassigned')).items, []);
  assert.equal((await f.monitor('viewer')).items[0].canCancel, false);
  assert.equal((await f.request('POST', '/api/nodes/task/cancel', 'viewer')).statusCode, 403);
});

test('launch identity comes from the session, survives renaming and is inherited by graph attempts', async t => {
  const f = fixture([node('first'), node('gate', ['first'], 'gate')]); t.after(f.close);
  const response = await f.request('POST', '/api/graphs/graph/run', 'editor', { initiator: { id: 'forged', name: 'forged' } });
  assert.equal(response.statusCode, 202); await tick();
  const expected = { id: 'editor', name: 'Launch editor' };
  assert.deepEqual(response.json().initiator, expected);
  f.app.db.prepare('UPDATE users SET name=? WHERE id=?').run('Renamed editor', 'editor');
  assert.deepEqual(f.app.runtime.attempts('org', 'first')[0].initiator, expected);
  f.finish('first'); await tick();
  assert.deepEqual(f.app.runtime.attempts('org', 'gate')[0].initiator, expected);
  const monitor = await f.monitor();
  assert.equal(monitor.items.length, 1, 'graph attempts must not duplicate the graph row');
  assert.deepEqual(monitor.items[0].initiator, expected);
  assert.equal(monitor.items[0].reason, 'Waiting for human approval');
  assert.equal((await f.request('POST', '/api/graphs/graph/run/cancel', 'viewer')).statusCode, 403);
  assert.equal((await f.request('POST', '/api/graphs/graph/run/cancel')).statusCode, 200);
  assert.equal((await f.request('POST', '/api/graphs/graph/run/cancel')).statusCode, 409);
});

test('waiting reasons distinguish preparation, dependencies, review and paused rework', async t => {
  const f = fixture([node('upstream'), node('review', ['upstream'], 'gate')]); t.after(f.close);
  await f.request('POST', '/api/graphs/graph/run'); await tick();
  let item = (await f.monitor()).items[0];
  assert.equal(item.tasks?.find(n => n.id === 'upstream')?.reason, 'Waiting for workspace or executor preparation');
  assert.equal(item.tasks?.find(n => n.id === 'review')?.reason, 'Waiting for: upstream');
  assert.doesNotMatch(JSON.stringify(item), /position|queue number/i);
  f.calls[0].onPrepared?.({ workspaceBefore: null, assembledPrompt: 'PRIVATE_PROMPT' });
  assert.equal((await f.monitor()).items[0].tasks?.find(n => n.id === 'upstream')?.status, 'running');
  f.finish('upstream'); await tick();
  const attempt = f.app.runtime.attempts('org', 'review')[0];
  await f.request('POST', '/api/nodes/review/decision', 'editor', { attemptId: attempt.id, decision: 'request_changes', targetNodeId: 'upstream', feedback: 'Private feedback' });
  item = (await f.monitor()).items[0];
  assert.match(item.reason, /waiting for a team editor to resume/);
  assert.doesNotMatch(JSON.stringify(item), /Private feedback/);
});

test('cancel shows executor cleanup honestly and repeated cancel does not create a run', async t => {
  const f = fixture(); t.after(f.close);
  const started = await f.request('POST', '/api/nodes/task/run', 'editor', { initiator: { id: 'forged' } }); await tick();
  assert.deepEqual(started.json().initiator, { id: 'editor', name: 'Launch editor' });
  assert.equal((await f.request('POST', '/api/nodes/task/cancel')).statusCode, 200);
  const stopping = (await f.monitor()).items[0];
  assert.equal(stopping.status, 'stopping'); assert.equal(stopping.active, true); assert.equal(stopping.canCancel, false);
  assert.equal((await f.request('POST', '/api/nodes/task/cancel')).statusCode, 200);
  f.finish('task'); await tick();
  assert.equal((await f.monitor()).items[0].status, 'canceled');
  assert.equal((await f.monitor()).items[0].active, false);
  assert.equal((await f.request('POST', '/api/nodes/task/cancel')).statusCode, 409);
  assert.equal(f.app.runtime.attempts('org', 'task').length, 1);
});

test('history is bounded, active first, and legacy initiators remain unrecorded', async t => {
  const f = fixture([node('task'), node('active')]); t.after(f.close);
  const actor = { id: 'actual-launcher', name: 'Original name' };
  const initial = f.app.runtime.runNode('org', 'task', actor); actor.name = 'Mutated caller'; await tick();
  assert.equal(initial.initiator?.name, 'Original name');
  f.finish('task'); await tick();
  for (let i = 0; i < 52; i++) {
    f.app.runtime.runNode('org', 'task'); await tick(); f.finish('task'); await tick();
  }
  await f.request('POST', '/api/nodes/active/run'); await tick();
  const result = await f.monitor();
  assert.equal(result.total, 54); assert.equal(result.items.length, 50);
  assert.equal(result.items[0].name, 'active'); assert.equal(result.items[0].active, true);
  assert.equal(result.items[1].initiator, undefined, 'legacy launches must not inherit the node author');
});

test('launch identities and history persist across backend reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'teamweave-monitor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'test.db');
  const f = fixture([node('task')], dbPath);
  const launch = await f.request('POST', '/api/nodes/task/run'); await tick(); f.finish('task'); await tick(); await f.close();
  const reopened = buildApp({ dbPath, executor: async () => { throw new Error('History must not execute'); } });
  t.after(() => reopened.close());
  const response = await reopened.inject({ method: 'GET', url: '/api/run-monitor', cookies: { tw_session: 'editor' } });
  const item = (response.json() as RunMonitorResponse).items[0];
  assert.equal(item.id, launch.json().id); assert.equal(item.status, 'done');
  assert.deepEqual(item.initiator, { id: 'editor', name: 'Launch editor' });
});


test('a stale monitor row cannot cancel a newer task attempt or project run', async t => {
  const f = fixture(); t.after(f.close);
  const first = (await f.request('POST', '/api/nodes/task/run')).json(); await tick(); f.finish('task'); await tick();
  const second = (await f.request('POST', '/api/nodes/task/run')).json(); await tick();
  assert.equal((await f.request('POST', '/api/nodes/task/cancel', 'editor', { attemptId: first.id })).statusCode, 409);
  assert.equal(f.app.runtime.attempts('org', 'task').find((a: { id: string; status: string }) => a.id === second.id)?.status, 'running');
  assert.equal((await f.request('POST', '/api/nodes/task/cancel', 'editor', { attemptId: 5 })).statusCode, 400);
  f.finish('task'); await tick();
  const oldRun = (await f.request('POST', '/api/graphs/graph/run')).json();
  assert.equal((await f.request('POST', '/api/nodes', 'editor', { teamId: 'team', graphId: 'graph', name: 'Fresh review', type: 'gate' })).statusCode, 201);
  const newRun = (await f.request('POST', '/api/graphs/graph/run')).json();
  assert.notEqual(oldRun.id, newRun.id);
  assert.equal((await f.request('POST', '/api/graphs/graph/run/cancel', 'editor', { runId: oldRun.id })).statusCode, 409);
  assert.equal((await f.request('POST', '/api/graphs/graph/run/cancel', 'editor', { runId: false })).statusCode, 400);
  assert.equal(f.app.runtime.latestRun('org', 'graph')?.status, 'waiting');
});
