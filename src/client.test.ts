import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from './api';
import { useStore, flushEdits, sessionRequest } from './store';
import {
  boardNodes,
  ancestors,
  effectiveRole,
  mergePatch,
  nodeDefinition,
  handoffBody,
  type Auth,
} from './client-helpers';
import { assemblePrompt } from './prompt';
import type { WorkerNode, Project, Team } from './types';
const auth: Auth = {
  user: { id: 'u', name: 'User', email: 'user@example.com' },
  organization: { id: 'org', name: 'Company' },
  role: 'admin',
  teamRoles: [],
};
const teams: Team[] = [
  ['dept', null, 'department'],
  ['nested', 'dept', 'department'],
  ['team', 'nested', 'team'],
  ['other', null, 'team'],
].map(([id, parentId, kind]) => ({
  id: id!,
  name: id!,
  parentId,
  kind: kind as Team['kind'],
  space: { x: 0, y: 0, w: 1200, h: 480 },
}));
const graph = {
  id: 'f8ba859b-26ea-47e5-b014-ecf7760ba521',
  teamId: 'team',
  name: 'Project',
  goal: '',
  repo: '',
  conventions: '',
};
function node(id = 'node', teamId = 'team', graphId = graph.id): WorkerNode {
  return {
    id,
    teamId,
    graphId,
    type: 'worker',
    name: 'Task',
    status: 'draft',
    priority: 'normal',
    progress: 0,
    prompt: { task: 'old', refinements: [], comments: [] },
    executor: {
      provider: 'mock',
      model: 'mock-v1',
      skills: [],
      tools: [],
      maxIterations: 3,
    },
    context: { files: [], extra: '' },
    owners: { author: auth.user.email, responsible: [] },
    inputs: [],
    output: { summary: '', results: [], commands: [], artifacts: [] },
    history: [],
    version: 1,
    position: { x: 10, y: 20 },
  };
}
function project(): Project & { revision: number } {
  return {
    version: 1,
    teams,
    graphContexts: [graph],
    nodes: [node(), node('outsider', 'other', 'other-graph')],
    templates: [
      {
        id: 'tpl',
        name: 'Template',
        description: '',
        isBuiltIn: true,
        defaults: {
          prompt: { task: 'Template task', refinements: [], comments: [] },
        },
      },
    ],
    revision: 1,
  };
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const originalFetch = globalThis.fetch;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function ready(p = project()) {
  useStore.setState({ ...p, auth, loading: false, error: null });
  useStore.getState().navigate('team');
}
afterEach(async () => {
  globalThis.fetch = async () => json({ error: 'Expired' }, 401);
  await useStore.getState().bootstrap();
  globalThis.fetch = originalFetch;
});
test('API includes cookies, rejects invalid/error JSON and handles 204', async () => {
  let options: RequestInit | undefined;
  globalThis.fetch = async (_, init) => {
    options = init;
    return new Response(null, { status: 204 });
  };
  assert.equal(await api('/test', 'POST', { ok: true }), undefined);
  assert.equal(options?.credentials, 'include');
  assert.equal(options?.body, '{"ok":true}');
  globalThis.fetch = async () => json({ error: 'Denied' }, 403);
  await assert.rejects(
    api('/test'),
    (e: unknown) =>
      e instanceof ApiError && e.status === 403 && e.message === 'Denied',
  );
  globalThis.fetch = async () => new Response('not JSON');
  await assert.rejects(api('/test'), /invalid JSON/);
});
test('bootstrap 401 leaves a cleared login state, not loading forever', async () => {
  globalThis.fetch = async () => json({ error: 'Not authenticated' }, 401);
  await useStore.getState().bootstrap();
  assert.equal(useStore.getState().auth, null);
  assert.equal(useStore.getState().loading, false);
  assert.equal(useStore.getState().nodes.length, 0);
});
test('nested navigation/back and selected board exclude other team and project', () => {
  ready();
  const s = useStore.getState();
  assert.equal(s.selectedGraphId, graph.id);
  assert.deepEqual(
    boardNodes(s.nodes, s.selectedTeamId, s.selectedGraphId).map((n) => n.id),
    ['node'],
  );
  const trail = ancestors(s.teams, s.navigationId);
  assert.deepEqual(
    trail.map((t) => t.id),
    ['dept', 'nested', 'team'],
  );
  s.navigate(trail[trail.length - 2].id);
  assert.equal(useStore.getState().navigationId, 'nested');
  assert.equal(useStore.getState().selectedTeamId, null);
  s.navigate(null);
  assert.equal(useStore.getState().navigationId, null);
});
test('closest explicit inherited viewer overrides editor; ancestor navigation cannot edit', () => {
  const member: Auth = {
    ...auth,
    role: 'member',
    teamRoles: [
      { teamId: 'dept', role: 'editor' },
      { teamId: 'nested', role: 'viewer' },
    ],
  };
  assert.equal(effectiveRole(member, teams, 'team'), 'viewer');
  assert.equal(
    effectiveRole(
      { ...member, teamRoles: [{ teamId: 'team', role: 'viewer' }] },
      teams,
      'dept',
    ),
    null,
  );
  ready();
  useStore.setState({ auth: member });
  useStore.getState().updateNode('node', { name: 'forbidden' });
  assert.equal(useStore.getState().nodes[0].name, 'Task');
});
test('rapid edits survive polling; PATCH serializes nested updates and flush precedes run', async () => {
  const p = project();
  const first = deferred<Response>();
  const calls: string[] = [];
  let patches = 0;
  let active = 0;
  let peak = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/auth/me') return json(useStore.getState().auth);
    const path = String(url);
    calls.push(`${init?.method} ${path}`);
    if (path === '/api/project') return json(p);
    if (path.endsWith('/run') && init?.method === 'GET') return json(null);
    if (init?.method === 'PATCH') {
      patches++;
      active++;
      peak = Math.max(peak, active);
      const patch = JSON.parse(String(init.body));
      const response =
        patches === 1
          ? await first.promise
          : json({
              ...mergePatch(p.nodes[0], patch),
              revision: p.revision + 1,
            });
      active--;
      p.nodes[0] = mergePatch(p.nodes[0], patch);
      p.revision++;
      return response;
    }
    return json({ id: 'attempt', status: 'running' });
  };
  ready(p);
  const s = useStore.getState();
  s.updateNode('node', { prompt: { ...s.nodes[0].prompt, task: 'first' } });
  const flushing = flushEdits();
  await Promise.resolve();
  s.updateNode('node', {
    prompt: {
      ...useStore.getState().nodes[0].prompt,
      task: 'newest',
      comments: [{ ts: 'now', author: auth.user.email, text: 'keep' }],
    },
  });
  await s.refresh();
  assert.equal(useStore.getState().nodes[0].prompt.task, 'newest');
  const run = s.runNode('node');
  assert.equal(
    calls.some((c) => c === 'POST /api/nodes/node/run'),
    false,
  );
  first.resolve(
    json({
      ...node(),
      prompt: { ...node().prompt, task: 'first' },
      revision: 2,
    }),
  );
  await flushing;
  await run;
  assert.equal(peak, 1);
  assert.equal(patches, 2);
  assert.equal(useStore.getState().nodes[0].prompt.task, 'newest');
  assert.equal(useStore.getState().nodes[0].prompt.comments[0].text, 'keep');
  assert.ok(
    calls.lastIndexOf('PATCH /api/nodes/node') <
      calls.indexOf('POST /api/nodes/node/run'),
  );
});
test('stale poll cannot erase a completed newer PATCH', async () => {
  const oldPoll = deferred<Response>();
  ready();
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/auth/me') return json(useStore.getState().auth);
    if (String(url) === '/api/project') return oldPoll.promise;
    if (init?.method === 'PATCH')
      return json({ ...node(), name: 'new name', revision: 2 });
    return json(null);
  };
  const poll = useStore.getState().refresh();
  useStore.getState().updateNode('node', { name: 'new name' });
  await flushEdits();
  oldPoll.resolve(json(project()));
  await poll;
  assert.equal(useStore.getState().nodes[0].name, 'new name');
});
test('failed edit restores authoritative data and prevents run; run errors do not simulate', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/auth/me') return json(useStore.getState().auth);
    const path = String(url);
    calls.push(`${init?.method} ${path}`);
    if (init?.method === 'PATCH') return json({ error: 'Save denied' }, 403);
    if (path === '/api/project') return json(project());
    if (init?.method === 'POST')
      return json({ error: 'Bob not configured' }, 422);
    return json(null);
  };
  ready();
  useStore.getState().updateNode('node', { name: 'bad' });
  await useStore.getState().runNode('node');
  assert.equal(calls.includes('POST /api/nodes/node/run'), false);
  assert.equal(useStore.getState().nodes[0].name, 'Task');
  assert.equal(useStore.getState().error, 'Save denied');
  await useStore.getState().runNode('node');
  assert.equal(useStore.getState().error, 'Bob not configured');
  assert.equal(useStore.getState().nodes[0].status, 'draft');
  assert.deepEqual(useStore.getState().nodes[0].history, []);
});
test('401 clears pending selections and rejects stale previous-account responses', async () => {
  ready();
  const late = deferred<Response>();
  globalThis.fetch = async (url) =>
    String(url) === '/api/late'
      ? late.promise
      : json({ error: 'expired' }, 401);
  const stale = sessionRequest('/late');
  useStore.getState().updateNode('node', { name: 'pending' });
  await assert.rejects(sessionRequest('/protected'), /expired/);
  assert.equal(useStore.getState().auth, null);
  assert.equal(useStore.getState().selectedGraphId, null);
  assert.equal(useStore.getState().nodes.length, 0);
  ready();
  late.resolve(json({ secret: 'old account' }));
  await assert.rejects(stale, /stale response/);
});
test('logout during pending Run flush never dispatches into the next account', async () => {
  ready();
  const patch = deferred<Response>();
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/auth/me') return json(useStore.getState().auth);
    calls.push(String(url));
    return init?.method === 'PATCH'
      ? patch.promise
      : new Response(null, { status: 204 });
  };
  useStore.getState().updateNode('node', { name: 'pending' });
  const run = useStore.getState().runNode('node');
  await Promise.resolve();
  const logout = useStore.getState().logout();
  assert.equal(calls.includes('/api/auth/logout'), false);
  patch.resolve(json({ ...node(), name: 'previous account' }));
  await logout;
  ready();
  await run;
  assert.equal(calls.includes('/api/nodes/node/run'), false);
  assert.equal(useStore.getState().nodes[0].name, 'Task');
  assert.equal(useStore.getState().error, null);
});
test('UUID template creation uses selected real graph and waits for server id', async () => {
  const p = project();
  let payload: Record<string, unknown> | undefined;
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/auth/me') return json(useStore.getState().auth);
    if (String(url) === '/api/nodes') {
      payload = JSON.parse(String(init?.body));
      p.nodes.push({ ...node('server-uuid'), name: 'Template' });
      p.revision++;
      return json(p.nodes[p.nodes.length - 1]);
    }
    if (String(url) === '/api/project') return json(p);
    return json(null);
  };
  ready(p);
  assert.equal(await useStore.getState().applyTemplate('tpl', 'team'), true);
  assert.equal(payload?.graphId, graph.id);
  assert.equal('id' in payload!, false);
  assert.equal('owners' in payload!, false);
  assert.equal(useStore.getState().selectedNodeId, 'server-uuid');
});
test('workspace override clears with null; definition PATCH excludes runtime/provenance', async () => {
  ready();
  const sent: Record<string, unknown>[] = [];
  globalThis.fetch = async (_, init) => {
    const patch = JSON.parse(String(init?.body));
    sent.push(patch);
    return json({ ...mergePatch(node(), patch), revision: sent.length + 1 });
  };
  const workspace = { path: '/existing/git', branch: 'feature', ref: 'HEAD' };
  useStore.getState().updateNode('node', { workspace });
  await flushEdits();
  useStore.getState().updateNode('node', { workspace: null });
  await flushEdits();
  assert.deepEqual(sent, [{ workspace }, { workspace: null }]);
  const definition = nodeDefinition({ ...node(), type: 'worker' });
  for (const key of [
    'id',
    'status',
    'progress',
    'output',
    'history',
    'version',
    'inboxMeta',
    'currentAttemptId',
  ])
    assert.equal(key in definition, false);
});
test('handoff references exact source attempt and carries no destination node/workspace', () => {
  const source = {
    ...node(),
    status: 'done' as const,
    currentAttemptId: 'attempt-exact',
    workspace: { path: '/secret/workspace', branch: 'main', ref: 'HEAD' },
  };
  assert.deepEqual(
    handoffBody(source, 'other', 'Please review', 'request-uuid', 'high'),
    {
      targetTeamId: 'other',
      message: 'Please review',
      requestId: 'request-uuid',
      priority: 'high',
      sourceAttemptId: 'attempt-exact',
    },
  );
});
test('pure prompt preview uses exact formatter with instructions and provenance', () => {
  const task = node();
  task.executor.skills = ['research'];
  const preview = assemblePrompt(
    task,
    graph,
    [
      {
        fromNodeId: 'source',
        attemptId: 'frozen',
        summary: 'upstream',
        results: [],
        commands: ['rm -rf advisory'],
        artifacts: [],
      },
    ],
    null,
  );
  assert.match(preview, /attempt frozen/);
  assert.match(preview, /Commands \(mentioned, do NOT execute\)/);
  assert.match(preview, /analysis report/);
  assert.match(preview, /NOT automatically installed integrations/);
});

test('handoff omits a non-successful current attempt, allowing server latest-success fallback', () => {
  for (const status of ['running', 'failed', 'needs_approval'] as const)
    assert.equal(
      'sourceAttemptId' in
        handoffBody(
          { ...node(), status, currentAttemptId: 'not-successful' },
          'other',
          'Request',
          'request',
          'normal',
        ),
      false,
    );
});
test('newer draft survives an older failing PATCH during polling', async () => {
  ready();
  const first = deferred<Response>();
  const p = project();
  let patches = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/auth/me') return json(useStore.getState().auth);
    if (init?.method === 'PATCH') {
      patches++;
      if (patches === 1) return first.promise;
      const patch = JSON.parse(String(init.body));
      p.nodes[0] = mergePatch(p.nodes[0], patch);
      p.revision++;
      return json({ ...p.nodes[0], revision: p.revision });
    }
    if (String(url) === '/api/project') return json(p);
    return json(null);
  };
  useStore
    .getState()
    .updateNode('node', { prompt: { ...node().prompt, task: 'first' } });
  const flush = flushEdits();
  await Promise.resolve();
  useStore
    .getState()
    .updateNode('node', { prompt: { ...node().prompt, task: 'newer draft' } });
  first.resolve(json({ error: 'Earlier save failed' }, 409));
  await assert.rejects(flush, /Earlier save failed/);
  assert.equal(useStore.getState().nodes[0].prompt.task, 'newer draft');
  assert.equal(patches, 2);
});

test('server-created node remains selected when an older poll is already in flight', async () => {
  ready();
  const oldPoll = deferred<Response>();
  const created = { ...node('created-uuid'), revision: 2 };
  globalThis.fetch = async (url, init) =>
    String(url) === '/api/auth/me' ? json(useStore.getState().auth) :
    String(url) === '/api/project'
      ? oldPoll.promise
      : String(url) === '/api/nodes' && init?.method === 'POST'
        ? json(created)
        : json(null);
  const polling = useStore.getState().refresh();
  const creating = useStore.getState().createNode();
  await new Promise((resolve) => setImmediate(resolve));
  oldPoll.resolve(json(project()));
  await polling;
  await creating;
  assert.equal(useStore.getState().selectedNodeId, 'created-uuid');
  assert.equal(
    useStore.getState().nodes.some((n) => n.id === 'created-uuid'),
    true,
  );
});

test('wrong login credentials remain a visible error with a cleared login state', async () => {
  globalThis.fetch = async () =>
    json({ error: 'Invalid email or password' }, 401);
  await useStore
    .getState()
    .authenticate('login', {
      email: 'user@example.com',
      password: 'wrong-password',
    });
  assert.equal(useStore.getState().auth, null);
  assert.equal(useStore.getState().loading, false);
  assert.equal(useStore.getState().error, 'Invalid email or password');
});


test('immediate logout saves the last debounced edit before ending the session', async () => {
  ready();
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/auth/me') return json(useStore.getState().auth);
    calls.push(String(url));
    if (init?.method === 'PATCH') {
      assert.equal(JSON.parse(String(init.body)).name, 'Last edit');
      return json({ ...node(), name: 'Last edit', revision: 2 });
    }
    return new Response(null, { status: 204 });
  };
  useStore.getState().updateNode('node', { name: 'Last edit' });
  await useStore.getState().logout();
  assert.deepEqual(calls, ['/api/nodes/node', '/api/auth/logout']);
  assert.equal(useStore.getState().auth, null);
});

test('failed save blocks logout and reports the failure in the existing session', async () => {
  ready();
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/auth/me') return json(useStore.getState().auth);
    calls.push(String(url));
    if (init?.method === 'PATCH') return json({ error: 'Save unavailable' }, 503);
    if (String(url) === '/api/project') return json(project());
    return json(null);
  };
  useStore.getState().updateNode('node', { name: 'Unsaved edit' });
  await useStore.getState().logout();
  assert.equal(calls.includes('/api/auth/logout'), false);
  assert.equal(useStore.getState().auth?.user.id, auth.user.id);
  assert.equal(useStore.getState().loading, false);
  assert.match(useStore.getState().error ?? '', /Save unavailable/);
});


test('failed logout request keeps the session available for retry', async () => {
  ready();
  globalThis.fetch = async () => json({ error: 'Logout unavailable' }, 503);
  await useStore.getState().logout();
  assert.equal(useStore.getState().auth?.user.id, auth.user.id);
  assert.equal(useStore.getState().loading, false);
  assert.equal(useStore.getState().error, 'Logout unavailable');
  globalThis.fetch = async () => new Response(null, { status: 204 });
  await useStore.getState().logout();
  assert.equal(useStore.getState().auth, null);
});

test('session expiry while logout drains a save never logs out the next account', async () => {
  ready();
  const patch = deferred<Response>();
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === '/api/auth/me') return json(useStore.getState().auth);
    calls.push(String(url));
    if (init?.method === 'PATCH') return patch.promise;
    return json({ error: 'Expired' }, 401);
  };
  useStore.getState().updateNode('node', { name: 'Old account' });
  const logout = useStore.getState().logout();
  await assert.rejects(sessionRequest('/protected'), /Expired/);
  ready();
  patch.resolve(json({ ...node(), name: 'Old account', revision: 2 }));
  await logout;
  assert.equal(calls.includes('/api/auth/logout'), false);
  assert.equal(useStore.getState().nodes[0].name, 'Task');
  assert.equal(useStore.getState().error, null);
});
