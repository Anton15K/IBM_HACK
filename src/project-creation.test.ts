import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from './project-creation';
import { sessionGeneration, useStore } from './store';
import type { WorkspaceBinding } from './types';

const originalFetch = globalThis.fetch;
const workspace: WorkspaceBinding = { path: '/repos/project', branch: 'main', ref: 'HEAD' };
const graph = { id: 'new', teamId: 'team', name: 'Project', goal: '', repo: '', conventions: '', workspace };
const input = { teamId: 'team', name: ' Project ', goal: '', source: { kind: 'clone' as const, parentPath: '/repos', name: 'project', url: 'https://github.com/owner/repo' } };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function ready(role: 'admin' | 'editor' = 'admin') {
  useStore.setState({
    auth: { user: { id: 'u', name: 'User', email: 'u@example.com' }, organization: { id: 'org', name: 'Org' }, role: role === 'admin' ? 'admin' : 'member', teamRoles: role === 'editor' ? [{ teamId: 'team', role: 'editor' }] : [] },
    teams: [{ id: 'team', name: 'Team', parentId: null, kind: 'team', space: { x: 0, y: 0, w: 1, h: 1 } }],
    graphContexts: [], nodes: [], selectedTeamId: 'team', selectedGraphId: null,
  });
}
afterEach(async () => {
  globalThis.fetch = async () => json({ error: 'Expired' }, 401);
  await useStore.getState().bootstrap();
  globalThis.fetch = originalFetch;
});

test('retries project creation with the prepared workspace, without cloning twice', async () => {
  ready();
  const calls: string[] = [];
  let graphAttempts = 0;
  let prepared: WorkspaceBinding | undefined;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push(path);
    if (path === '/api/workspace/create') return json(workspace);
    if (path === '/api/workspace/validate') return json({ ok: true, ...workspace });
    if (path === '/api/graphs') {
      assert.equal(JSON.parse(String(init?.body)).name, 'Project');
      return ++graphAttempts === 1 ? json({ error: 'Try again' }, 503) : json(graph);
    }
    if (path === '/api/project') return json({ version: 1, revision: 100, teams: useStore.getState().teams, graphContexts: [graph], nodes: [], templates: [] });
    throw new Error(`Unexpected ${path}`);
  };
  const remember = (binding: WorkspaceBinding) => { prepared = binding; };
  const generation = sessionGeneration();
  await assert.rejects(createProject(input, generation, prepared, remember), /Try again/);
  assert.deepEqual(prepared, workspace);
  await createProject(input, generation, prepared, remember);
  assert.equal(calls.filter(path => path === '/api/workspace/create').length, 1);
  assert.equal(calls.filter(path => path === '/api/workspace/validate').length, 2);
  assert.equal(useStore.getState().selectedGraphId, graph.id);
});

test('editors validate an existing folder and use the detected branch', async () => {
  ready('editor');
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push(path);
    if (path === '/api/workspace/validate') {
      assert.equal(JSON.parse(String(init?.body)).branch, '');
      return json({ ok: true, path: workspace.path, branch: 'develop' });
    }
    if (path === '/api/graphs') {
      assert.deepEqual(JSON.parse(String(init?.body)).workspace, { ...workspace, branch: 'develop' });
      return json(graph);
    }
    if (path === '/api/project') return json({ version: 1, revision: 101, teams: useStore.getState().teams, graphContexts: [graph], nodes: [], templates: [] });
    throw new Error(`Unexpected ${path}`);
  };
  await createProject({ ...input, source: { kind: 'existing', workspace: { ...workspace, branch: '' } } }, sessionGeneration(), undefined, () => assert.fail('Existing folder must not be prepared'));
  assert.deepEqual(calls, ['/api/workspace/validate', '/api/graphs', '/api/project']);
});

test('editors cannot prepare a repository', async () => {
  ready('editor');
  globalThis.fetch = async () => { throw new Error('No request expected'); };
  await assert.rejects(createProject(input, sessionGeneration(), undefined, () => {}), /Only admins/);
});

test('an invalid Git folder never creates a project', async () => {
  ready();
  globalThis.fetch = async url => {
    assert.equal(String(url), '/api/workspace/validate');
    return json({ ok: false, message: 'Not a Git worktree' });
  };
  await assert.rejects(createProject({ ...input, source: { kind: 'existing', workspace } }, sessionGeneration(), undefined, () => {}), /Not a Git worktree/);
  assert.equal(useStore.getState().graphContexts.length, 0);
});

test('a session change during preparation ignores the late binding and stops creation', async () => {
  ready();
  let resolve!: (response: Response) => void;
  globalThis.fetch = async url => {
    if (String(url) === '/api/workspace/create') return new Promise<Response>(done => { resolve = done; });
    return json({ error: 'Expired' }, 401);
  };
  let saved = false;
  const creation = createProject(input, sessionGeneration(), undefined, () => { saved = true; });
  await useStore.getState().bootstrap();
  resolve(json(workspace));
  await assert.rejects(creation, /Session changed/);
  assert.equal(saved, false);
  assert.equal(useStore.getState().graphContexts.length, 0);
});
