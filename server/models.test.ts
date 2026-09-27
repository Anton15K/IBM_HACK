import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildApp } from './app.js';
import { ModelService, validateBaseUrl } from './models.js';
import { executeApiTask, fetchBounded, fetchBoundedWithRetry, providerHttpError, API_MAX_RETRIES, API_DEFAULT_TIMEOUT_MS, API_DEFAULT_OUTPUT_TOKENS, API_MAX_OUTPUT_TOKENS } from './apiExecutor.js';
import { dispatchTool, toolReadFile, toolWriteFile, toolListFiles, toolRunTests } from './modelTools.js';
import { validatePlan } from './routes/planner.js';
import { openDb } from './db.js';
import type { WorkerNode, GraphContext } from '../src/types.js';

const secret = 'fixture-secret-not-a-real-api-key';
const response = (content: string | null, calls?: unknown[]) => new Response(JSON.stringify({ id: 'req-fixture', choices: [{ finish_reason: calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
const call = (name: string, args: object, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function register(app: ReturnType<typeof buildApp>, email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'fixture-password-123', name: 'Test', organizationName: 'Test org' } });
  assert.equal(r.statusCode, 201, r.body);
  return { cookie: r.headers['set-cookie']!.toString().split(';')[0]!, auth: r.json() };
}
const profile = { label: 'Test model', model: 'glm-4.7-flash', baseUrl: 'https://api.z.ai/api/paas/v4', apiKey: secret };
test('local HTTP models require an exact private endpoint opt-in', () => {
  const local = 'http://192.168.1.76:1234/v1';
  assert.ok(validateBaseUrl(local, [], []));
  assert.equal(validateBaseUrl(local, [], [local]), null);
  assert.equal(validateBaseUrl(local + '/', [], [local]), null);
  for (const url of [
    'http://192.168.1.77:1234/v1', 'http://192.168.1.76:1235/v1',
    'http://192.168.1.76:1234/other', local + '?key=secret', local + '#fragment',
    'http://user:secret@192.168.1.76:1234/v1',
  ]) assert.ok(validateBaseUrl(url, [], [local]), url);
  for (const url of ['http://8.8.8.8:1234/v1', 'http://169.254.169.254/v1', 'http://example.com/v1'])
    assert.ok(validateBaseUrl(url, [], [url]), url);
  assert.equal(validateBaseUrl('https://openrouter.ai/api/v1', ['openrouter.ai'], [local]), null);
  assert.ok(validateBaseUrl('https://openrouter.ai:8443/api/v1', ['openrouter.ai'], [local]));
});

test('local connection credentials remain encrypted and endpoint permission is rechecked', async t => {
  const previous = process.env.TEAMWEAVE_LOCAL_MODEL_URLS;
  t.after(() => {
    if (previous === undefined) delete process.env.TEAMWEAVE_LOCAL_MODEL_URLS;
    else process.env.TEAMWEAVE_LOCAL_MODEL_URLS = previous;
  });
  const local = 'http://192.168.1.76:1234/v1';
  process.env.TEAMWEAVE_LOCAL_MODEL_URLS = local;
  const app = buildApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const a = await register(app, 'local-model@example.test');
  const created = await app.inject({ method: 'POST', url: '/api/model-connections', headers: { cookie: a.cookie }, payload: { ...profile, baseUrl: local } });
  assert.equal(created.statusCode, 201, created.body);
  assert.ok(!created.body.includes(secret));
  const service = new ModelService(app.db, ':memory:');
  assert.equal((await service.getApiKey(created.json().id, a.auth.organization.id))?.apiKey, secret);
  delete process.env.TEAMWEAVE_LOCAL_MODEL_URLS;
  await assert.rejects(service.getApiKey(created.json().id, a.auth.organization.id), /no longer allowed/);
});
async function repo() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'tw-model-')));
  execFileSync('git', ['init', '-b', 'main', path]);
  await writeFile(join(path, 'add.mjs'), 'export const add = (a,b) => a-b;\n');
  await writeFile(join(path, 'add.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from './add.mjs'; test('adds',()=>assert.equal(add(2,3),5));\n");
  execFileSync('git', ['-C', path, 'add', '.']);
  execFileSync('git', ['-C', path, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture']);
  return path;
}
function node(connectionId: string): WorkerNode {
  return { id: 'n', graphId: 'g', teamId: 't', name: 'Fix add', type: 'worker', status: 'draft', priority: 'normal', progress: 0, prompt: { task: 'Fix add', refinements: [], comments: [] }, executor: { provider: 'api', model: 'untrusted-label', connectionId, skills: [], tools: [], maxIterations: 4 }, desiredOutput: 'patch', context: { files: [], extra: '' }, owners: { author: 'a', responsible: [] }, inputs: [], output: { summary: '', results: [], commands: [], artifacts: [] }, history: [], version: 1, position: { x: 0, y: 0 } };
}

test('model profiles protect secrets and tenant boundaries; URL supports API paths', async t => {
  assert.equal(validateBaseUrl(profile.baseUrl), null);
  for (const url of ['http://api.z.ai/v1', 'https://localhost/v1', 'https://api.z.ai:8443/v1', 'https://user:pw@api.z.ai/v1', 'https://api.z.ai/v1?key=secret']) assert.ok(validateBaseUrl(url));
  assert.equal(validateBaseUrl('https://openrouter.ai/api/v1'), null);
  assert.ok(validateBaseUrl('https://evil-openrouter.ai/api/v1'));
  const app = buildApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const a = await register(app, 'a@example.test'), b = await register(app, 'b@example.test');
  const created = await app.inject({ method: 'POST', url: '/api/model-connections', headers: { cookie: a.cookie }, payload: profile });
  assert.equal(created.statusCode, 201, created.body); assert.ok(!created.body.includes(secret));
  const list = await app.inject({ method: 'GET', url: '/api/model-connections', headers: { cookie: a.cookie } });
  assert.equal(list.json().connections.length, 1); assert.ok(!list.body.includes(secret)); assert.ok(!list.body.includes('encryptedApiKey'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/model-connections', headers: { cookie: b.cookie } })).json().connections.length, 0);
  const row = app.db.prepare('SELECT encryptedApiKey FROM model_connections').get()!;
  assert.ok(!String(row.encryptedApiKey).includes(secret));
  app.db.prepare("UPDATE org_memberships SET role='member' WHERE userId=?").run(a.auth.user.id);
  assert.equal((await app.inject({ method: 'POST', url: '/api/model-connections', headers: { cookie: a.cookie }, payload: profile })).statusCode, 403);
});

test('graphs require a folder; planner proposes without executing and Apply rejects stale/cyclic plans', async t => {
  const plan = { nodes: [{ id: 'a', name: 'Fix', task: 'Fix add.mjs', output: 'patch', dependsOn: [] }, { id: 'b', name: 'Review', task: 'Inspect fix', output: 'report', dependsOn: ['a'] }] };
  let requests = 0;
  const app = buildApp({ dbPath: ':memory:', modelOptions: { fetchFn: async () => { requests++; return response(JSON.stringify(plan)); } } }); t.after(() => app.close());
  const a = await register(app, 'plan@example.test');
  const req = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, headers: { cookie: a.cookie }, payload });
  const project = (await req('GET', '/api/project')).json();
  assert.equal((await req('POST', '/api/graphs', { teamId: project.teams[0].id, name: 'Missing folder' })).statusCode, 400);
  const graph = (await req('POST', '/api/graphs', { teamId: project.teams[0].id, name: 'Project', workspace: { path: '/tmp/project', branch: 'main', ref: 'HEAD' } })).json();
  assert.equal(graph.workspace.path, '/tmp/project');
  const c = (await req('POST', '/api/model-connections', profile)).json();
  const proposal = await req('POST', `/api/graphs/${graph.id}/plan`, { connectionId: c.id, intent: 'Fix arithmetic' });
  assert.equal(proposal.statusCode, 200, proposal.body); assert.equal(requests, 1);
  assert.equal((await req('GET', '/api/project')).json().nodes.length, 0);
  const payload = { plan: proposal.json().plan, expectedRevision: proposal.json().revision, connectionId: c.id };
  assert.equal((await req('POST', `/api/graphs/${graph.id}/apply-plan`, { ...payload, expectedRevision: -1 })).statusCode, 409);
  const applied = await req('POST', `/api/graphs/${graph.id}/apply-plan`, payload);
  assert.equal(applied.statusCode, 201, applied.body); assert.equal(applied.json().nodes[0].status, 'draft'); assert.equal(requests, 1);
  assert.equal((await req('POST', `/api/graphs/${graph.id}/apply-plan`, payload)).statusCode, 409);
  assert.throws(() => validatePlan({ nodes: [{ ...plan.nodes[0], dependsOn: ['b'] }, plan.nodes[1]] }), /cycle/);
  assert.throws(() => validatePlan({ nodes: [{ ...plan.nodes[0], workspace: { path: '/tmp/secret' } }] }), /Unknown/);
});

test('API executor edits actual Git fixture, runs tests, snapshots and records real usage', async t => {
  const path = await repo(); t.after(() => rm(path, { recursive: true, force: true }));
  const db = openDb(':memory:'); t.after(() => db.close());
  const service = new ModelService(db, ':memory:'); const c = await service.create('org', profile.label, profile.baseUrl, profile.model, secret);
  const graph: GraphContext = { id: 'g', teamId: 't', goal: 'Fix', repo: '', conventions: '', workspace: { path, branch: 'main', ref: 'HEAD' } };
  let requests = 0, prepared = false;
  const result = await executeApiTask({ orgId: 'org', connectionId: c.id, modelService: service, input: { node: node(c.id), graph, incoming: [], assembledPrompt: 'Fix add', allowedRoots: [path], signal: new AbortController().signal, onPrepared: () => { prepared = true; } }, fetchFn: async (url, options) => {
    assert.ok(prepared); assert.equal(String(url), profile.baseUrl + '/chat/completions'); assert.equal(options?.redirect, 'error');
    const body = JSON.parse(options?.body as string); assert.ok(!JSON.stringify(body).includes(secret));
    requests++;
    if (requests === 1) return response(null, [call('write_file', { path: 'add.mjs', content: 'export const add = (a,b) => a+b;\n' }), call('run_tests', {})]);
    assert.match(JSON.stringify(body.messages), /Exit code: 0/);
    return response(JSON.stringify({ summary: 'Fixed', results: [], commands: ['invented shell'], artifacts: ['invented-file'] }));
  } });
  assert.equal(result.status, 'done'); assert.equal(result.meta.model, profile.model); assert.equal(result.sessionCosts, null); assert.equal(result.meta.apiUsage?.totalTokens, 30);
  assert.notEqual(result.workspaceBefore?.fingerprint, result.workspaceAfter?.fingerprint);
  if (result.status === 'done') { assert.deepEqual(result.output.commands, ['node --test']); assert.deepEqual(result.output.artifacts, ['add.mjs']); }
  assert.match(await readFile(join(path, 'add.mjs'), 'utf8'), /a\+b/);
  execFileSync(process.execPath, ['--test'], { cwd: path, env: { PATH: process.env.PATH } });
  const denied = await executeApiTask({ orgId: 'other', connectionId: c.id, modelService: service, input: { node: node(c.id), graph, incoming: [], assembledPrompt: '', signal: new AbortController().signal }, fetchFn: async () => { throw new Error('Should not fetch'); } });
  assert.equal(denied.status, 'failed');
});

test('API tasks can finish after more than eight model rounds', async t => {
  const path = await repo(); t.after(() => rm(path, { recursive: true, force: true }));
  const db = openDb(':memory:'); t.after(() => db.close());
  const service = new ModelService(db, ':memory:');
  const c = await service.create('org', profile.label, profile.baseUrl, profile.model, secret);
  const task = node(c.id); task.executor.maxIterations = 12;
  let requests = 0;
  const result = await executeApiTask({ orgId: 'org', connectionId: c.id, modelService: service,
    input: { node: task, graph: { id: 'g', teamId: 't', goal: '', repo: '', conventions: '', workspace: { path, branch: 'main', ref: 'HEAD' } }, incoming: [], assembledPrompt: 'Inspect', allowedRoots: [path], signal: new AbortController().signal },
    fetchFn: async () => ++requests <= 9 ? response(null, [call('list_files', {}, `list-${requests}`)]) : response('Finished') });
  assert.equal(requests, 10);
  assert.equal(result.status, 'done');
});

test('file tools reject symlinks including dangling targets, secrets and report writes', async t => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'tw-tools-'))); t.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, '.env'), 'hidden'); await writeFile(join(path, 'visible.txt'), 'original');
  await symlink(join(path, '.env'), join(path, 'alias')); await symlink(join(path, 'missing.txt'), join(path, 'dangling'));
  for (const file of ['.env', 'alias', '../outside', 'dangling']) assert.match(await toolReadFile({ path: file }, path), /^Error:/);
  assert.match(await toolWriteFile({ path: 'dangling', content: 'bad' }, path), /^Error:/);
  assert.match(await toolWriteFile({ path: 'visible.txt' }, path), /^Error:/);
  const denied = await dispatchTool({ id: 'x', name: 'write_file', arguments: { path: 'visible.txt', content: 'bad' } }, path, true, new AbortController().signal);
  assert.match(denied.content, /not available/); assert.equal(await readFile(join(path, 'visible.txt'), 'utf8'), 'original');
  await mkdir(join(path, '.git')); await writeFile(join(path, '.git', 'config'), 'hidden');
  assert.ok(!(await toolListFiles({}, path)).includes('.git')); assert.match(await toolListFiles({ path: '.git' }, path), /^Error:/);
  const canceled = AbortSignal.abort(); assert.match(await toolRunTests({}, path, canceled), /canceled before/);
});

test('bounded response rejects excess data', async () => {
  await assert.rejects(fetchBounded('https://api.z.ai/test', {}, async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))), /size limit/);
});

test('failed API call preserves mutations and known usage without leaking provider error text', async t => {
  const path = await repo(); t.after(() => rm(path, { recursive: true, force: true }));
  const db = openDb(':memory:'); t.after(() => db.close());
  const modelService = new ModelService(db, ':memory:'); const c = await modelService.create('org', profile.label, profile.baseUrl, profile.model, secret);
  const graph: GraphContext = { id: 'g', teamId: 't', goal: '', repo: '', conventions: '', workspace: { path, branch: 'main', ref: 'HEAD' } };
  let calls = 0;
  const result = await executeApiTask({ orgId: 'org', connectionId: c.id, modelService, input: { node: node(c.id), graph, incoming: [], assembledPrompt: '', allowedRoots: [path], signal: new AbortController().signal }, fetchFn: async () => {
    if (++calls === 1) return response(null, [call('write_file', { path: 'add.mjs', content: 'export const add = (a,b) => a+b;\n' })]);
    return new Response(JSON.stringify({ error: { message: secret } }), { status: 429 });
  } });
  assert.equal(result.status, 'failed'); assert.equal(result.meta.apiUsage?.totalTokens, 15); assert.ok(result.workspaceAfter);
  assert.notEqual(result.workspaceBefore?.fingerprint, result.workspaceAfter?.fingerprint);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('API execution honors abort and unsupported output before provider calls', async t => {
  const path = await repo(); t.after(() => rm(path, { recursive: true, force: true }));
  const db = openDb(':memory:'); t.after(() => db.close());
  const modelService = new ModelService(db, ':memory:'); const c = await modelService.create('org', profile.label, profile.baseUrl, profile.model, secret);
  const graph: GraphContext = { id: 'g', teamId: 't', goal: '', repo: '', conventions: '', workspace: { path, branch: 'main', ref: 'HEAD' } };
  let calls = 0;
  const invoke = (n: WorkerNode, signal: AbortSignal) => executeApiTask({ orgId: 'org', connectionId: c.id, modelService, input: { node: n, graph, incoming: [], assembledPrompt: '', allowedRoots: [path], signal }, fetchFn: async () => { calls++; return response('Never'); } });
  const canceled = await invoke(node(c.id), AbortSignal.abort()); assert.equal(canceled.status, 'failed'); assert.equal(canceled.workspaceBefore, null);
  const commit = await invoke({ ...node(c.id), desiredOutput: 'commit' }, new AbortController().signal); assert.equal(commit.status, 'failed'); assert.equal(calls, 0);
});

test('persisted model credential survives restart and invalid master key is not overwritten', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tw-vault-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'db.sqlite'); const db = openDb(dbPath); t.after(() => db.close());
  const first = new ModelService(db, dbPath); const c = await first.create('org', profile.label, profile.baseUrl, profile.model, secret);
  assert.equal((await new ModelService(db, dbPath).getApiKey(c.id, 'org'))?.apiKey, secret);
  const keyPath = join(dir, '.teamweave_model_key'); await writeFile(keyPath, 'broken');
  await assert.rejects(new ModelService(db, dbPath).getApiKey(c.id, 'org'), /Invalid model master key/);
  assert.equal(await readFile(keyPath, 'utf8'), 'broken');
});


test('upstream errors expose a safe business code, never a raw message', () => {
  assert.equal(providerHttpError(429, JSON.stringify({ error: { code: '1113', message: secret } })), 'API responded with HTTP 429 (provider code 1113)');
  assert.equal(providerHttpError(429, JSON.stringify({ error: { code: secret, message: secret } })), 'API responded with HTTP 429');
});

test('fetchBoundedWithRetry survives transient 429/5xx and gives up after bounded attempts', async () => {
  const ok = response('ok');
  // 429 then success → succeeds on second attempt
  let calls = 0;
  let r = await fetchBoundedWithRetry('https://api.z.ai/x', {}, async () => { calls++; return calls === 1 ? new Response('rate limited', { status: 429 }) : ok; }, new AbortController().signal);
  assert.equal(r.status, 200); assert.equal(calls, 2);
  // Persistent 429 → returns last response after max retries, does not throw
  calls = 0;
  r = await fetchBoundedWithRetry('https://api.z.ai/x', {}, async () => { calls++; return new Response('rate limited', { status: 429 }); }, new AbortController().signal);
  assert.equal(r.status, 429); assert.equal(calls, API_MAX_RETRIES + 1);
  // Non-retryable status → single call, no retry
  calls = 0;
  r = await fetchBoundedWithRetry('https://api.z.ai/x', {}, async () => { calls++; return new Response('nope', { status: 404 }); }, new AbortController().signal);
  assert.equal(r.status, 404); assert.equal(calls, 1);
});

test('fetchBoundedWithRetry honors abort during backoff', async () => {
  const ctrl = new AbortController();
  const attempt = fetchBoundedWithRetry('https://api.z.ai/x', {}, async () => new Response('rate limited', { status: 429 }), ctrl.signal);
  await new Promise(r => setTimeout(r, 20));
  ctrl.abort();
  await assert.rejects(attempt, /Canceled/);
});


test('retry cancellation before backoff registration rejects without sleeping', async () => {
  const ctrl = new AbortController();
  let calls = 0;
  const pending = fetchBoundedWithRetry('https://api.z.ai/x', { signal: ctrl.signal }, async () => {
    calls++; ctrl.abort(); return new Response(null, { status: 503 });
  }, ctrl.signal);
  // Deterministic turn boundary: the old implementation still waits 1500ms here.
  let settled = false;
  const observed = pending.catch((error) => { assert.match(error.message, /Canceled/); settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true);
  await observed;
  assert.equal(calls, 1);
});

test('API reports deadline expiry separately from manual cancellation and forwards large output limits', async t => {
  const path = await repo(); t.after(() => rm(path, { recursive: true, force: true }));
  const db = openDb(':memory:'); t.after(() => db.close());
  const modelService = new ModelService(db, ':memory:');
  const c = await modelService.create('org', profile.label, profile.baseUrl, profile.model, secret);
  const graph: GraphContext = { id: 'g', teamId: 't', goal: '', repo: '', conventions: '', workspace: { path, branch: 'main', ref: 'HEAD' } };
  for (const manual of [false, true]) {
    const ctrl = new AbortController();
    const result = await executeApiTask({ orgId: 'org', connectionId: c.id, modelService,
      input: { node: node(c.id), graph, incoming: [], assembledPrompt: '', allowedRoots: [path], signal: ctrl.signal, timeoutMs: manual ? 1000 : 10 },
      fetchFn: async (_url, options) => {
        const signal = options!.signal!;
        return new Promise<Response>((_resolve, reject) => {
          const cancel = () => reject(new DOMException('Aborted', 'AbortError'));
          signal.addEventListener('abort', cancel, { once: true });
          if (manual) ctrl.abort();
          else if (signal.aborted) cancel();
        });
      } });
    assert.equal(result.status, 'failed');
    if (result.status === 'failed') {
      assert.match(result.error, manual ? /cancelled/ : /timed out after 0.01 seconds/);
      if (!manual) assert.doesNotMatch(result.error, /cancelled/);
    }
  }
  assert.equal(API_DEFAULT_TIMEOUT_MS, 600_000);
  assert.equal(API_DEFAULT_OUTPUT_TOKENS, 1024);
  assert.equal(API_MAX_OUTPUT_TOKENS, 65_536);
  for (const limit of [undefined, 65_536, 100_000]) {
    const task = node(c.id); task.executor.maxOutputTokens = limit;
    const result = await executeApiTask({ orgId: 'org', connectionId: c.id, modelService,
      input: { node: task, graph, incoming: [], assembledPrompt: '', allowedRoots: [path], signal: new AbortController().signal },
      fetchFn: async (_url, options) => {
        assert.equal(JSON.parse(String(options!.body)).max_tokens, limit === undefined ? 1024 : 65_536);
        return response('Complete report');
      } });
    assert.equal(result.status, 'done');
  }
});

test('bounded response accepts long answers above the previous one MiB limit', async () => {
  const body = 'x'.repeat(2 * 1024 * 1024);
  const result = await fetchBounded('https://api.z.ai/test', {}, async () => new Response(body));
  assert.equal(result.body.length, body.length);
});
