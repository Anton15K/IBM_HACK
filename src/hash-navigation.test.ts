import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectHashNavigation, type NavigationHost } from './hash-navigation';
import { useStore } from './store';
import type { Team } from './types';

let cleanup = () => {};
afterEach(() => cleanup());
function fixture(hash: string, loading = false) {
  const teams: Team[] = ['team', 'other', 'dept'].map(id => ({ id, name: id, parentId: null,
    kind: id === 'dept' ? 'department' : 'team', space: { x: 0, y: 0, w: 1200, h: 480 } }));
  useStore.setState({ auth: { user: { id: 'u', name: 'U', email: 'u@example.test' },
    organization: { id: 'org', name: 'Org' }, role: 'admin', teamRoles: [] }, loading,
    teams, nodes: [], graphContexts: [ ['first', 'team'], ['second', 'team'], ['private', 'other'] ].map(([id, teamId]) => ({ id: id!, teamId: teamId!, name: id, goal: '', repo: '', conventions: '' })),
    navigationId: null, selectedTeamId: null, selectedGraphId: null, selectedNodeId: null });
  const listeners = new Set<() => void>();
  const pushed: string[] = [];
  const host: NavigationHost = { location: { hash }, history: {
    pushState: (_, __, url) => { pushed.push(url); host.location.hash = url; },
    replaceState: (_, __, url) => { host.location.hash = url; },
  }, addEventListener: (_, fn) => { listeners.add(fn); }, removeEventListener: (_, fn) => { listeners.delete(fn); } };
  cleanup = connectHashNavigation(host);
  return { host, pushed, go: (url: string) => { host.location.hash = url; listeners.forEach(fn => fn()); }, listeners };
}
test('deep link waits for authenticated project bootstrap and restores exact project', () => {
  const { host, pushed } = fixture('#/teams/team/projects/second', true);
  assert.equal(useStore.getState().navigationId, null);
  useStore.setState({ loading: false });
  assert.equal(useStore.getState().selectedGraphId, 'second');
  assert.equal(host.location.hash, '#/teams/team/projects/second');
  assert.deepEqual(pushed, []);
});
test('navigation and graph selection write history; hash Back/Forward restores without a new entry', () => {
  const { host, pushed, go } = fixture('#/');
  useStore.getState().navigate('team');
  useStore.getState().selectGraph('second');
  assert.equal(host.location.hash, '#/teams/team/projects/second');
  assert.equal(pushed.length, 2);
  go('#/teams/team/projects/first');
  assert.equal(useStore.getState().selectedGraphId, 'first');
  assert.equal(pushed.length, 2);
  go('#/teams/dept');
  assert.equal(useStore.getState().navigationId, 'dept');
  assert.equal(useStore.getState().selectedGraphId, null);
});
test('unknown and malformed IDs fall back safely; cross-team project IDs are rejected', () => {
  const { host, go } = fixture('#/teams/missing/projects/private');
  assert.equal(host.location.hash, '#/');
  go('#/teams/team/projects/private');
  assert.equal(useStore.getState().selectedGraphId, 'first');
  assert.equal(host.location.hash, '#/teams/team/projects/first');
  go('#/teams/%ZZ');
  assert.equal(host.location.hash, '#/');
});
test('logout clears prior route and session; initial signed-out deep link survives login', () => {
  const { host } = fixture('#/teams/team/projects/second');
  const auth = useStore.getState().auth;
  useStore.setState({ auth: null, loading: true, navigationId: null, selectedGraphId: null, selectedTeamId: null });
  assert.equal(host.location.hash, '#/');
  useStore.setState({ auth, loading: false });
  assert.equal(useStore.getState().navigationId, null);
  cleanup();
  host.location.hash = '#/teams/team/projects/second';
  useStore.setState({ auth: null });
  cleanup = connectHashNavigation(host);
  useStore.setState({ auth, loading: true });
  assert.equal(host.location.hash, '#/teams/team/projects/second');
  useStore.setState({ loading: false });
  assert.equal(useStore.getState().selectedGraphId, 'second');
});
test('polling does not duplicate history and removed teams fall back to company', () => {
  const { host, pushed } = fixture('#/teams/team/projects/second');
  useStore.setState({ nodes: [], graphRun: null });
  assert.deepEqual(pushed, []);
  useStore.setState({ teams: [] });
  assert.equal(host.location.hash, '#/');
  assert.equal(useStore.getState().navigationId, null);
});
test('disconnect removes subscriptions and hash listeners', () => {
  const { host, listeners } = fixture('#/');
  cleanup();
  assert.equal(listeners.size, 0);
  useStore.getState().navigate('team');
  assert.equal(host.location.hash, '#/');
});

test('legacy organization deep link resolves to implicit home without losing project navigation', () => {
  const { host, go } = fixture('#/', true);
  useStore.setState({ teams: [...useStore.getState().teams, { id: 'org-container', name: 'Organization', parentId: null, kind: 'organization', space: { x: 0, y: 0, w: 0, h: 0 } }] });
  host.location.hash = '#/teams/org-container';
  useStore.setState({ loading: false });
  assert.equal(host.location.hash, '#/');
  assert.equal(useStore.getState().navigationId, null);
  go('#/teams/team/projects/second');
  assert.equal(useStore.getState().selectedGraphId, 'second');
  go('#/teams/org-container');
  assert.equal(useStore.getState().selectedGraphId, null);
  assert.equal(host.location.hash, '#/');
});
