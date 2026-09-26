import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';
import { hashToken } from './auth.js';
import { Runtime, type Executor, type Attempt } from './runtime.js';
import type { ExecuteTaskInput, ExecuteTaskResult } from './executor.js';
import type { WorkerNode, Project, WorkspaceSnapshot } from '../src/types.js';

const output = (summary = '') => ({ summary, results: [], commands: [], artifacts: [] });
function node(id: string, inputs: string[] = [], type: WorkerNode['type'] = 'worker'): WorkerNode {
  return { id, teamId: 't', graphId: 'g', name: id, type, status: 'draft', priority: 'normal', progress: 0, prompt: { task: id, refinements: [], comments: [] }, executor: { provider: 'mock', model: 'mock', skills: [], tools: [], maxIterations: 1 }, context: { files: [], extra: '' }, owners: { author: 'editor', responsible: [] }, inputs: inputs.map(fromNodeId => ({ fromNodeId, enabled: true })), output: output(), history: [], version: 1, position: { x: 0, y: 0 } };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fake(honorAbort = true) {
  let workspace: WorkspaceSnapshot | null = null;
  const preparations = new Map<string, Promise<void>>();
  const calls: ExecuteTaskInput[] = [];
  const pending = new Map<string, (result: ExecuteTaskResult) => void>();
  const executor: Executor = async input => {
    calls.push(input);
    if (preparations.has(input.node.id)) await preparations.get(input.node.id);
    input.onPrepared?.({ workspaceBefore: workspace, assembledPrompt: input.assembledPrompt });
    return new Promise((resolve, reject) => {
      pending.set(input.attemptId!, resolve);
      if (honorAbort) input.signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true });
    });
  };
  function finish(id: string, status: 'done' | 'failed' = 'done', metadata: { taskId?: string; sessionCosts?: number; output?: WorkerNode['output'] } = {}) {
    const input = calls.filter(c => c.node.id === id).at(-1)!;
    const shared = { simulated: true, taskId: null, sessionCosts: null, identity: { attemptId: input.attemptId!, nodeId: id, nodeVersion: input.node.version, graphId: input.graph.id, ts: new Date().toISOString() }, meta: { provider: 'mock' as const, model: 'mock', durationMs: 1, status, simulated: true, taskId: null, sessionCosts: null }, workspaceBefore: null, workspaceAfter: workspace, ...metadata };
    pending.get(input.attemptId!)!(status === 'done' ? { ...shared, status, summary: id, output: metadata.output ?? output(id) } : { ...shared, status, error: 'Failed branch' });
  }
  return { executor, calls, finish, holdPreparation: (id: string, ready: Promise<void>) => preparations.set(id, ready), setWorkspace: (snapshot: WorkspaceSnapshot | null) => { workspace = snapshot; } };
}
function fixture(nodes: WorkerNode[], honorAbort = true) {
  const f = fake(honorAbort), app = buildApp({ dbPath: ':memory:', executor: f.executor });
  const db = app.db;
  db.prepare('INSERT INTO organizations(id,name) VALUES(?,?)').run('org', 'Org');
  const p: Project = { version: 1, nodes, teams: [{ id: 't', name: 'Source', parentId: null, space: { x: 0, y: 0, w: 1, h: 1 } }, { id: 'other', name: 'Destination', parentId: null, space: { x: 0, y: 0, w: 1, h: 1 } }], graphContexts: [{ id: 'g', teamId: 't', goal: '', repo: '', conventions: '' }, { id: 'dest', teamId: 'other', goal: '', repo: '', conventions: '' }], templates: [] };
  db.prepare('INSERT INTO projects(orgId,data) VALUES(?,?)').run('org', JSON.stringify(p));
  for (const user of ['editor', 'viewer']) {
    db.prepare('INSERT INTO users(id,email,name,passwordHash,salt) VALUES(?,?,?,?,?)').run(user, user + '@test.local', user, '', '');
    db.prepare('INSERT INTO org_memberships(userId,orgId,role) VALUES(?,?,?)').run(user, 'org', 'member');
    db.prepare('INSERT INTO team_memberships(userId,orgId,teamId,role) VALUES(?,?,?,?)').run(user, 'org', 't', user === 'editor' ? 'editor' : 'viewer');
    db.prepare('INSERT INTO sessions(tokenHash,userId,orgId,expiresAt) VALUES(?,?,?,?)').run(hashToken(user), user, 'org', Date.now() + 100000);
  }
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, user = 'editor') => app.inject({ method, url, payload, cookies: { tw_session: user } });
  return { ...f, app, request, runtime: app.runtime };
}

test('independent slow branch advances; join dispatches once with pinned attempts', async t => {
  const f = fixture([node('slow'), node('fast'), node('afterFast', ['fast']), node('join', ['slow', 'afterFast'])]); t.after(() => f.app.close());
  assert.equal((await f.request('POST', '/api/graphs/g/run')).statusCode, 202); await tick();
  assert.deepEqual(f.calls.map(c => c.node.id), ['slow', 'fast']);
  f.finish('fast'); await tick(); assert.equal(f.calls.at(-1)!.node.id, 'afterFast');
  f.finish('afterFast'); await tick(); assert.equal(f.calls.length, 3);
  f.finish('slow'); await tick(); assert.equal(f.calls.at(-1)!.node.id, 'join');
  assert.equal(f.calls.at(-1)!.incoming.length, 2); assert.ok(f.calls.at(-1)!.incoming.every(i => i.attemptId));
  f.finish('join'); await tick(); assert.equal(f.runtime.latestRun('org', 'g')!.status, 'completed'); assert.equal(f.calls.length, 4);
});

test('failed branch blocks descendants without retry while independent branch finishes', async t => {
  const f = fixture([node('bad'), node('blocked', ['bad']), node('good')]); t.after(() => f.app.close());
  await f.request('POST', '/api/graphs/g/run'); await tick(); f.finish('bad', 'failed'); await tick(); f.finish('good'); await tick();
  assert.deepEqual(f.calls.map(c => c.node.id), ['bad', 'good']); assert.equal(f.runtime.node('org', 'blocked').status, 'blocked'); assert.equal(f.runtime.latestRun('org', 'g')!.status, 'failed');
});

test('gate approval resumes graph and duplicate decisions fail', async t => {
  const f = fixture([node('first'), node('gate', ['first'], 'gate'), node('last', ['gate'])]); t.after(() => f.app.close());
  await f.request('POST', '/api/graphs/g/run'); await tick(); f.finish('first'); await tick();
  assert.equal(f.runtime.node('org', 'gate').status, 'needs_approval'); assert.equal(f.calls.length, 1);
  const gate = f.runtime.node('org', 'gate').currentAttemptId!;
  assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId: 'stale', decision: 'approve' })).statusCode, 409);
  assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId: gate, decision: 'approve' })).statusCode, 200); await tick();
  assert.equal(f.calls.at(-1)!.node.id, 'last'); assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId: gate, decision: 'approve' })).statusCode, 409);
  f.finish('last'); await tick(); assert.equal(f.runtime.latestRun('org', 'g')!.status, 'completed');
});

test('rework waits for resume, snapshots feedback, and enforces attempt bound', async t => {
  const f = fixture([node('first'), node('gate', ['first'], 'gate'), node('last', ['gate'])]); t.after(() => f.app.close());
  await f.request('POST', '/api/graphs/g/run'); await tick();
  for (let round = 0; round < 2; round++) {
    f.finish('first'); await tick(); const attemptId = f.runtime.node('org', 'gate').currentAttemptId!;
    assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId, decision: 'request_changes', targetNodeId: 'first', feedback: 'Fix ' + round })).statusCode, 200);
    assert.equal(f.runtime.latestRun('org', 'g')!.status, 'waiting'); assert.equal(f.runtime.node('org', 'gate').status, 'blocked');
    assert.equal((await f.request('POST', '/api/graphs/g/resume')).statusCode, 202); await tick(); assert.equal(f.calls.at(-1)!.node.prompt.refinements.length, round + 1);
  }
  f.finish('first'); await tick();
  assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId: f.runtime.node('org', 'gate').currentAttemptId, decision: 'request_changes', targetNodeId: 'first' })).statusCode, 409);
  assert.equal(f.runtime.attempts('org', 'first').length, 3);
});

test('prompt edits only change next snapshot; active topology mutation is rejected', async t => {
  const f = fixture([node('first')]); t.after(() => f.app.close());
  await f.request('POST', '/api/nodes/first/run'); await tick();
  assert.equal((await f.request('PATCH', '/api/nodes/first', { prompt: { task: 'new prompt', refinements: [], comments: [] } })).statusCode, 200);
  assert.equal(f.calls[0]!.node.prompt.task, 'first'); assert.equal(f.runtime.attempts('org', 'first')[0]!.node.prompt.task, 'first');
  assert.equal((await f.request('PATCH', '/api/nodes/first', { type: 'gate' })).statusCode, 409);
  assert.equal((await f.request('DELETE', '/api/nodes/first')).statusCode, 409);
  assert.equal((await f.request('PATCH', '/api/nodes/first', { currentAttemptId: 'invented' })).statusCode, 400);
  f.finish('first'); await tick(); await f.request('POST', '/api/nodes/first/run'); await tick(); assert.equal(f.calls[1]!.node.prompt.task, 'new prompt');
});

test('cancel cannot be overwritten by late completion', async t => {
  const f = fixture([node('first')], false); t.after(() => f.app.close());
  await f.request('POST', '/api/nodes/first/run'); await tick();
  assert.equal((await f.request('POST', '/api/nodes/first/cancel')).statusCode, 200); f.finish('first', 'done', { taskId: 'late-task', sessionCosts: 0.2 }); await tick();
  assert.equal(f.runtime.node('org', 'first').status, 'failed'); assert.equal(f.runtime.attempts('org', 'first')[0]!.error, 'Canceled');
  assert.equal(f.runtime.attempts('org', 'first')[0]!.sessionCosts, 0.2); assert.equal(f.runtime.node('org', 'first').history[0]!.taskId, 'late-task');
});

test('viewer mutation endpoints denied and known foreign IDs stay scoped', async t => {
  const f = fixture([node('first'), node('gate', ['first'], 'gate')]); t.after(() => f.app.close());
  for (const url of ['/api/nodes/first/run', '/api/nodes/first/cancel', '/api/nodes/gate/decision', '/api/nodes/first/handoff', '/api/graphs/g/run', '/api/graphs/g/run/cancel', '/api/graphs/g/resume']) assert.equal((await f.request('POST', url, {}, 'viewer')).statusCode, 403);
  const foreign = { ...node('foreign'), teamId: 'foreignTeam', graphId: 'foreignGraph' };
  f.app.db.prepare('INSERT INTO organizations(id,name) VALUES(?,?)').run('foreignOrg', 'Foreign');
  f.app.db.prepare('INSERT INTO projects(orgId,data) VALUES(?,?)').run('foreignOrg', JSON.stringify({ version: 1, nodes: [foreign], teams: [{ id: 'foreignTeam', name: 'Private', parentId: null, space: {} }], graphContexts: [{ id: 'foreignGraph', teamId: 'foreignTeam', goal: '', repo: '', conventions: '' }], templates: [] }));
  assert.equal((await f.request('GET', '/api/nodes/foreign/attempts')).statusCode, 404);
  assert.equal((await f.request('POST', '/api/nodes/foreign/run')).statusCode, 404);
  assert.equal((await f.request('GET', '/api/graphs/foreignGraph/run')).statusCode, 404);
  assert.equal((await f.request('POST', '/api/nodes/first/handoff', { targetTeamId: 'foreignTeam', requestId: 'one', message: 'hello' })).statusCode, 404);
});

test('handoff is idempotent and exposes recipient result without private graph', async t => {
  const f = fixture([node('source')]); t.after(() => f.app.close());
  await f.request('POST', '/api/nodes/source/run'); await tick(); f.finish('source'); await tick();
  const body = { targetTeamId: 'other', requestId: 'one', message: 'Please implement scoped request' };
  const receipt = (await f.request('POST', '/api/nodes/source/handoff', body)).json();
  assert.deepEqual((await f.request('POST', '/api/nodes/source/handoff', body)).json(), receipt);
  assert.equal((await f.request('GET', '/api/graphs/dest/run')).statusCode, 403);
  assert.equal((await f.request('GET', '/api/team-directory')).json().length, 2);
  const inbox = f.runtime.node('org', receipt.recipientNodeId); assert.equal(inbox.inboxMeta!.sourceOutput!.summary, 'source'); assert.equal(inbox.workspace, undefined);
  f.app.db.prepare('INSERT INTO team_memberships(userId,orgId,teamId,role) VALUES(?,?,?,?)').run('editor', 'org', 'other', 'editor');
  assert.equal((await f.request('POST', `/api/nodes/${inbox.id}/run`)).statusCode, 409);
  assert.equal((await f.request('PATCH', `/api/nodes/${inbox.id}`, { type: 'worker' })).statusCode, 200);
  assert.equal(f.runtime.node('org', inbox.id).inboxMeta!.sourceAttemptId, receipt.sourceAttemptId);
  await f.request('POST', `/api/nodes/${inbox.id}/run`); await tick(); assert.equal(f.calls.at(-1)!.incoming[0]!.attemptId, receipt.sourceAttemptId);
  f.finish(inbox.id); await tick(); const linked = (await f.request('GET', '/api/nodes/source/handoffs')).json()[0]; assert.equal(linked.recipient.status, 'done'); assert.equal(linked.recipient.summary, inbox.id); assert.equal(linked.recipient.prompt, undefined);
});

test('startup fails unfinished persisted attempts and never executes them', async t => {
  const f = fixture([node('first')]); t.after(() => f.app.close());
  const a = f.runtime.runNode('org', 'first');
  const persisted = { ...a, id: 'interrupted', status: 'running' } as Attempt;
  f.app.db.prepare('INSERT INTO execution_attempts(id,orgId,nodeId,graphId,payload) VALUES(?,?,?,?,?)').run(persisted.id, 'org', 'first', 'g', JSON.stringify(persisted));
  const runtime = new Runtime(f.app.db, async () => { throw new Error('Must not execute'); });
  assert.equal(runtime.attempts('org', 'first').find(a => a.id === 'interrupted')!.status, 'failed');
  assert.equal(f.runtime.node('org', 'first').status, 'failed');
  await tick();
});

function snapshot(fingerprint: string): WorkspaceSnapshot {
  return { path: '/local/repo', repositoryPath: '/local/repo', branch: 'main', requestedRef: 'HEAD', commitSha: 'sha', dirty: true, fingerprint, trackedDiff: '', untracked: [] };
}

test('same-worktree join compares latest completed state and drift fails before work', async t => {
  const f = fixture([node('a'), node('b'), node('join', ['a', 'b']), node('after', ['join'])]); t.after(() => f.app.close());
  await f.request('POST', '/api/graphs/g/run'); await tick();
  f.setWorkspace(snapshot('older')); f.finish('a'); await tick();
  f.setWorkspace(snapshot('latest')); f.finish('b'); await tick();
  assert.equal(f.runtime.node('org', 'join').status, 'running');
  assert.deepEqual(f.calls.at(-1)!.incoming.map(i => i.workspaceAfter!.fingerprint), ['older', 'latest']);
  f.finish('join'); f.setWorkspace(snapshot('drifted')); await tick();
  assert.equal(f.runtime.node('org', 'after').status, 'failed');
  assert.match(f.runtime.attempts('org', 'after')[0]!.error!, /drift/);
});

test('successful explicit reruns remain possible beyond three historical attempts', async t => {
  const f = fixture([node('first')]); t.after(() => f.app.close());
  for (let i = 0; i < 4; i++) {
    assert.equal((await f.request('POST', '/api/nodes/first/run')).statusCode, 202); await tick(); f.finish('first'); await tick();
  }
  assert.equal(f.runtime.attempts('org', 'first').length, 4);
});

test('graph rework rounds bounded independently from configured worker attempts', async t => {
  const first = node('first'); first.executor.maxAttempts = 10;
  const f = fixture([first, node('gate', ['first'], 'gate')]); t.after(() => f.app.close());
  await f.request('POST', '/api/graphs/g/run'); await tick();
  for (let round = 0; round < 3; round++) {
    f.finish('first'); await tick();
    assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId: f.runtime.node('org', 'gate').currentAttemptId, decision: 'request_changes', targetNodeId: 'first' })).statusCode, 200);
    await f.request('POST', '/api/graphs/g/resume'); await tick();
  }
  f.finish('first'); await tick();
  assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId: f.runtime.node('org', 'gate').currentAttemptId, decision: 'request_changes', targetNodeId: 'first' })).statusCode, 409);
  assert.equal(f.runtime.latestRun('org', 'g')!.reworkRounds, 3);
});

test('graph creation requires own-org editor and preserves independent project name', async t => {
  const f = fixture([]); t.after(() => f.app.close());
  const result = await f.request('POST', '/api/graphs', { teamId: 't', name: 'Second project', goal: 'Independent', workspace: { path: '/tmp/project', branch: 'main', ref: 'HEAD' } });
  assert.equal(result.statusCode, 201); const graph = result.json(); assert.notEqual(graph.id, 'g'); assert.equal(graph.name, 'Second project');
  assert.equal((await f.request('PATCH', `/api/graphs/${graph.id}`, { name: 'Renamed' })).json().name, 'Renamed');
  assert.equal((await f.request('POST', '/api/graphs', { teamId: 't', name: 'Denied', workspace: { path: '/tmp/project', branch: 'main', ref: 'HEAD' } }, 'viewer')).statusCode, 403);
  assert.equal((await f.request('POST', '/api/graphs', { teamId: 'foreign', name: 'Denied', workspace: { path: '/tmp/project', branch: 'main', ref: 'HEAD' } })).statusCode, 404);
});


test('rework continues graph-owned patches while gate preserves reviewed results and provenance', async t => {
  const f = fixture([node('analysis'), node('code', ['analysis']), node('gate', ['code'], 'gate'), node('final', ['gate'])]); t.after(() => f.app.close());
  await f.request('POST', '/api/graphs/g/run'); await tick();
  f.setWorkspace(snapshot('analysis-base')); f.finish('analysis'); await tick();
  const analysisAttempt = f.calls.find(c => c.node.id === 'analysis')!.attemptId;
  f.setWorkspace(snapshot('code-first-patch')); f.finish('code'); await tick();
  const oldGateId = f.runtime.node('org', 'gate').currentAttemptId!;
  assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId: oldGateId, decision: 'request_changes', targetNodeId: 'code', feedback: 'Fix tests' })).statusCode, 200);
  assert.equal((await f.request('POST', '/api/graphs/g/resume')).statusCode, 202); await tick();
  assert.equal(f.runtime.node('org', 'code').status, 'running');
  assert.equal(f.calls.at(-1)!.incoming[0]!.attemptId, analysisAttempt);
  assert.equal(f.calls.at(-1)!.incoming[0]!.workspaceAfter!.fingerprint, 'analysis-base');
  f.setWorkspace(snapshot('code-reworked-patch')); f.finish('code', 'done', { output: { summary: 'Implemented fix', results: ['Tests pass'], commands: ['npm test'], artifacts: ['fix.patch'] } }); await tick();
  const codeAttempt = f.calls.at(-1)!.attemptId;
  const gateId = f.runtime.node('org', 'gate').currentAttemptId!;
  assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId: gateId, decision: 'approve', feedback: 'Reviewed' })).statusCode, 200); await tick();
  assert.equal(f.runtime.node('org', 'final').status, 'running');
  const context = f.calls.at(-1)!.incoming;
  assert.ok(context.some(i => i.attemptId === gateId));
  assert.ok(context.some(i => i.attemptId === codeAttempt && i.workspaceAfter!.fingerprint === 'code-reworked-patch'));
  assert.ok(context.some(i => i.artifacts.includes('fix.patch') && i.results.includes('Tests pass')));
  assert.match(f.calls.at(-1)!.assembledPrompt, /Implemented fix/);
  assert.equal(f.runtime.attempts('org', 'gate').at(-1)!.decision!.actor, 'editor');
  assert.equal(f.runtime.attempts('org', 'gate')[0]!.decision!.decision, 'request_changes');
});

test('queued child accepts sibling graph checkpoint without changing its pinned dependency', async t => {
  const f = fixture([node('a'), node('b'), node('child', ['a'])]); t.after(() => f.app.close());
  let release!: () => void; f.holdPreparation('child', new Promise<void>(resolve => { release = resolve; }));
  await f.request('POST', '/api/graphs/g/run'); await tick();
  f.setWorkspace(snapshot('a-patch')); f.finish('a'); await tick();
  assert.equal(f.runtime.node('org', 'child').status, 'queued');
  f.setWorkspace(snapshot('a-plus-b-patches')); f.finish('b'); await tick(); release(); await tick();
  assert.equal(f.runtime.node('org', 'child').status, 'running');
  assert.equal(f.calls.at(-1)!.incoming[0]!.fromNodeId, 'a');
  assert.equal(f.calls.at(-1)!.incoming[0]!.workspaceAfter!.fingerprint, 'a-patch');
});

test('explicit reruns continue own checkpoint but another graph cannot authorize outside edits', async t => {
  const f = fixture([node('code')]); t.after(() => f.app.close());
  f.setWorkspace(snapshot('initial')); await f.request('POST', '/api/nodes/code/run'); await tick();
  f.setWorkspace(snapshot('own-patch')); f.finish('code'); await tick();
  await f.request('POST', '/api/nodes/code/run'); await tick(); assert.equal(f.runtime.node('org', 'code').status, 'running');
  f.finish('code'); await tick();
  f.setWorkspace(snapshot('foreign-graph-patch'));
  const prior = { ...f.runtime.attempts('org', 'code').at(-1)!, id: 'foreign-attempt', graphId: 'other-graph', finishedAt: new Date(Date.now() + 100).toISOString(), workspaceAfter: snapshot('foreign-graph-patch') };
  f.app.db.prepare('INSERT INTO execution_attempts(id,orgId,nodeId,graphId,payload) VALUES(?,?,?,?,?)').run(prior.id, 'org', 'foreign-node', prior.graphId, JSON.stringify(prior));
  await f.request('POST', '/api/nodes/code/run'); await tick(); assert.equal(f.runtime.node('org', 'code').status, 'failed');
  assert.match(f.runtime.attempts('org', 'code').at(-1)!.error!, /graph checkpoint/);
});


test('canceled subprocess keeps node and workspace busy until executor cleanup settles', async t => {
  const f = fixture([node('first')], false); t.after(() => f.app.close());
  await f.request('POST', '/api/nodes/first/run'); await tick();
  await f.request('POST', '/api/nodes/first/cancel');
  assert.equal((await f.request('POST', '/api/nodes/first/run')).statusCode, 409);
  assert.equal((await f.request('POST', '/api/graphs/g/run')).statusCode, 409);
  assert.equal((await f.request('PATCH', '/api/nodes/first', { type: 'gate' })).statusCode, 409);
  assert.equal((await f.request('DELETE', '/api/nodes/first')).statusCode, 409);
  assert.equal((await f.request('PATCH', '/api/graphs/g', { workspace: null })).statusCode, 409);
  f.finish('first'); await tick();
  assert.equal((await f.request('PATCH', '/api/nodes/first', { type: 'worker' })).statusCode, 200);
  assert.equal((await f.request('PATCH', '/api/graphs/g', { workspace: null })).statusCode, 200);
  assert.equal((await f.request('POST', '/api/nodes/first/run')).statusCode, 202); await tick(); f.finish('first'); await tick();
  assert.equal((await f.request('DELETE', '/api/nodes/first')).statusCode, 204);
});

test('graph cancellation remains idempotent through draining node cleanup', async t => {
  const f = fixture([node('first'), node('second')], false); t.after(() => f.app.close());
  await f.request('POST', '/api/graphs/g/run'); await tick();
  await f.request('POST', '/api/nodes/first/cancel');
  assert.equal((await f.request('POST', '/api/graphs/g/run/cancel')).statusCode, 200);
  f.finish('first'); f.finish('second'); await tick();
  assert.equal(f.runtime.latestRun('org', 'g')!.status, 'canceled');
  assert.equal(f.runtime.node('org', 'first').status, 'failed');
});


test('independent approval branch continues after another branch fails', async t => {
  const f = fixture([node('bad'), node('good'), node('gate', ['good'], 'gate'), node('last', ['gate'])]); t.after(() => f.app.close());
  await f.request('POST', '/api/graphs/g/run'); await tick();
  f.finish('bad', 'failed'); f.finish('good'); await tick();
  assert.equal(f.runtime.latestRun('org', 'g')!.status, 'waiting');
  const attemptId = f.runtime.node('org', 'gate').currentAttemptId!;
  assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId, decision: 'approve' })).statusCode, 200); await tick();
  assert.equal(f.runtime.node('org', 'last').status, 'running');
  f.finish('last'); await tick(); assert.equal(f.runtime.latestRun('org', 'g')!.status, 'failed');
});


test('explicit upstream rerun invalidates approved descendants without erasing history', async t => {
  const first = node('first');
  const gate = node('gate', ['first'], 'gate');
  const last = node('last', ['gate']);
  const unrelated = node('unrelated');
  unrelated.inputs = [{ fromNodeId: 'first', enabled: false }];
  const f = fixture([first, gate, last, unrelated]);
  t.after(() => f.app.close());
  await f.request('POST', '/api/graphs/g/run'); await tick();
  f.finish('first'); f.finish('unrelated'); await tick();
  const oldGate = f.runtime.node('org', 'gate').currentAttemptId!;
  await f.request('POST', '/api/nodes/gate/decision', { attemptId: oldGate, decision: 'approve' });
  await tick(); f.finish('last'); await tick();
  assert.equal(f.runtime.latestRun('org', 'g')!.status, 'completed');

  assert.equal((await f.request('POST', '/api/nodes/first/run')).statusCode, 202);
  await tick();
  assert.equal(f.runtime.node('org', 'gate').status, 'blocked');
  assert.equal(f.runtime.node('org', 'last').status, 'blocked');
  assert.equal(f.runtime.node('org', 'unrelated').status, 'done');
  assert.equal(f.runtime.attempts('org', 'gate')[0]!.status, 'done');
  assert.equal(f.runtime.node('org', 'last').history.length, 1);
  f.finish('first'); await tick();
  await f.request('POST', '/api/graphs/g/run'); await tick();
  const currentGate = f.runtime.node('org', 'gate').currentAttemptId!;
  assert.notEqual(currentGate, oldGate);
  assert.equal((await f.request('POST', '/api/nodes/gate/decision', { attemptId: oldGate, decision: 'approve' })).statusCode, 409);
  assert.equal(f.calls.filter(c => c.node.id === 'last').length, 1);
  assert.equal(f.runtime.attempts('org', 'gate').at(-1)!.incoming[0]!.attemptId, f.runtime.node('org', 'first').currentAttemptId);
  await f.request('POST', '/api/nodes/gate/decision', { attemptId: currentGate, decision: 'approve' });
  await tick(); f.finish('last'); await tick();
  assert.equal(f.runtime.latestRun('org', 'g')!.status, 'completed');
});

test('upstream rerun cannot invalidate a currently executing descendant', async t => {
  const f = fixture([node('first'), node('last', ['first'])]);
  t.after(() => f.app.close());
  await f.request('POST', '/api/nodes/first/run'); await tick();
  f.finish('first'); await tick();
  await f.request('POST', '/api/nodes/last/run'); await tick();
  const response = await f.request('POST', '/api/nodes/first/run');
  assert.equal(response.statusCode, 409);
  assert.match(response.json().error, /dependent/i);
  assert.equal(f.runtime.attempts('org', 'first').length, 1);
  assert.equal(f.runtime.node('org', 'last').status, 'running');
  f.finish('last'); await tick();
});
