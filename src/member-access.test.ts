import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { flushEdits, sessionGeneration, useStore } from './store';
import type { Auth } from './client-helpers';
import type { Project } from './types';

const originalFetch = globalThis.fetch;
const member: Auth = {
  user: { id: 'member', name: 'Developer', email: 'developer@example.test' },
  organization: { id: 'company', name: 'Company' },
  role: 'member',
  teamRoles: [],
};
const project: Project & { revision: number } = {
  version: 1, revision: 1, templates: [], nodes: [],
  teams: [{ id: 'team', name: 'Team', kind: 'team', parentId: null, space: { x: 0, y: 0, w: 0, h: 0 } }],
  graphContexts: [{ id: 'graph', teamId: 'team', goal: '', repo: '', conventions: '' }],
};
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function ready(auth = member) {
  useStore.setState({ ...project, auth, loading: false, error: null });
  useStore.getState().navigate('team');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  await useStore.getState().logout();
  globalThis.fetch = originalFetch;
});

test('refresh grants newly assigned editor access without login and preserves unchanged auth identity', async () => {
  ready();
  assert.equal(useStore.getState().canEdit('team'), false);
  const promoted: Auth = { ...member, teamRoles: [{ teamId: 'team', role: 'editor' }] };
  globalThis.fetch = async (url) => {
    if (String(url) === '/api/auth/me') return json(promoted);
    if (String(url) === '/api/project') return json(project);
    return json(null);
  };
  await useStore.getState().refresh();
  assert.equal(useStore.getState().canEdit('team'), true);
  const unchanged = useStore.getState().auth;
  await useStore.getState().refresh();
  assert.equal(useStore.getState().auth, unchanged, 'unchanged polling must not restart auth-dependent effects');
});

test('refresh removes edit access after demotion while preserving read access', async () => {
  ready({ ...member, teamRoles: [{ teamId: 'team', role: 'editor' }] });
  assert.equal(useStore.getState().canEdit('team'), true);
  const writes: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method !== 'GET') writes.push(String(url));
    if (String(url) === '/api/auth/me') return json({ ...member, teamRoles: [{ teamId: 'team', role: 'viewer' }] });
    if (String(url) === '/api/project') return json(project);
    return json(null);
  };
  await useStore.getState().refresh();
  assert.equal(useStore.getState().canEdit('team'), false);
  assert.equal(useStore.getState().selectedTeamId, 'team');
  assert.equal(useStore.getState().graphContexts[0].id, 'graph');
  useStore.getState().updateGraph('graph', { goal: 'Forbidden' });
  await useStore.getState().createNode();
  assert.equal(useStore.getState().graphContexts[0].goal, '');
  assert.deepEqual(writes, []);
});

test('late role response after logout cannot overwrite the next account or load its project', async () => {
  ready();
  const response = deferred<Response>();
  let projectReads = 0;
  globalThis.fetch = async (url) => {
    if (String(url) === '/api/auth/me') return response.promise;
    if (String(url) === '/api/project') projectReads++;
    return json(null);
  };
  const polling = useStore.getState().refresh();
  await useStore.getState().logout();
  const next: Auth = { ...member, user: { ...member.user, id: 'next-user' }, teamRoles: [] };
  ready(next);
  response.resolve(json({ ...member, role: 'admin' }));
  await polling;
  assert.equal(useStore.getState().auth, next);
  assert.equal(useStore.getState().error, null);
  assert.equal(projectReads, 0);
});

test('late project response after role refresh cannot repopulate a logged-out account', async () => {
  ready();
  const response = deferred<Response>();
  const started = deferred<void>();
  globalThis.fetch = async (url) => {
    if (String(url) === '/api/auth/me') return json(member);
    if (String(url) === '/api/project') { started.resolve(); return response.promise; }
    return json(null);
  };
  const polling = useStore.getState().refresh();
  await started.promise;
  await useStore.getState().logout();
  response.resolve(json(project));
  await polling;
  assert.equal(useStore.getState().auth, null);
  assert.deepEqual(useStore.getState().teams, []);
  assert.deepEqual(useStore.getState().graphContexts, []);
});


test('cross-tab organization change replaces high-revision data and cancels queued old drafts', async () => {
  ready();
  const oldProject = { ...project, revision: 50 };
  globalThis.fetch = async (url) => {
    if (String(url) === '/api/auth/me') return json(member);
    if (String(url) === '/api/project') return json(oldProject);
    return json(null);
  };
  await useStore.getState().refresh();
  useStore.setState({ auth: { ...member, teamRoles: [{ teamId: 'team', role: 'editor' }] } });
  useStore.getState().updateGraph('graph', { goal: 'Old private draft' });
  const oldGeneration = sessionGeneration();
  const next: Auth = { ...member, user: { ...member.user, id: 'other-user' }, organization: { id: 'other-company', name: 'Other company' } };
  const nextProject = { ...project, revision: 1, teams: [], graphContexts: [], nodes: [] };
  const writes: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method !== 'GET') writes.push(String(url));
    if (String(url) === '/api/auth/me') return json(next);
    if (String(url) === '/api/project') return json(nextProject);
    return json(null);
  };
  await useStore.getState().refresh();
  await flushEdits();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(sessionGeneration() > oldGeneration);
  assert.equal(useStore.getState().auth?.organization.id, 'other-company');
  assert.deepEqual(useStore.getState().graphContexts, []);
  assert.deepEqual(useStore.getState().teams, []);
  assert.equal(useStore.getState().selectedGraphId, null);
  assert.equal(useStore.getState().loading, false);
  assert.deepEqual(writes, [], 'identity switch must neither flush old drafts nor log out the shared cookie');
});

test('same-organization user change ignores an in-flight previous-user save', async () => {
  ready({ ...member, teamRoles: [{ teamId: 'team', role: 'editor' }] });
  const oldSave = deferred<Response>();
  const started = deferred<void>();
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'PATCH') { started.resolve(); return oldSave.promise; }
    return json(null);
  };
  useStore.getState().updateGraph('graph', { goal: 'Old draft' });
  const saving = flushEdits();
  const staleSave = assert.rejects(saving, /Session changed/);
  await started.promise;
  const next: Auth = { ...member, user: { ...member.user, id: 'new-viewer' } };
  const nextProject = { ...project, graphContexts: [{ ...project.graphContexts[0], goal: 'New account data' }] };
  globalThis.fetch = async (url) => {
    if (String(url) === '/api/auth/me') return json(next);
    if (String(url) === '/api/project') return json(nextProject);
    return json(null);
  };
  await useStore.getState().refresh();
  oldSave.resolve(json({ ...project.graphContexts[0], goal: 'Late old draft', revision: 100 }));
  await staleSave;
  assert.equal(useStore.getState().auth?.user.id, 'new-viewer');
  assert.equal(useStore.getState().graphContexts[0].goal, 'New account data');
  assert.equal(useStore.getState().error, null);
});
