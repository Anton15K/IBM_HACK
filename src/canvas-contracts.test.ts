import { afterEach, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useStore, flushEdits, sessionRequest } from './store';
import { mergePatch, type Auth } from './client-helpers';
import type { WorkerNode, Project, Team } from './types';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const auth: Auth = {
  user: { id: 'u1', name: 'Admin', email: 'admin@example.com' },
  organization: { id: 'org1', name: 'Org' },
  role: 'admin',
  teamRoles: [],
};

const editorAuth: Auth = {
  user: { id: 'u2', name: 'Editor', email: 'editor@example.com' },
  organization: { id: 'org1', name: 'Org' },
  role: 'member',
  teamRoles: [{ teamId: 'team1', role: 'editor' }],
};

const viewerAuth: Auth = {
  user: { id: 'u3', name: 'Viewer', email: 'viewer@example.com' },
  organization: { id: 'org1', name: 'Org' },
  role: 'member',
  teamRoles: [{ teamId: 'team1', role: 'viewer' }],
};

const teams: Team[] = [
  {
    id: 'team1',
    name: 'Engineering',
    parentId: null,
    kind: 'team',
    space: { x: 0, y: 0, w: 1200, h: 480 },
  },
];

const graph = {
  id: 'graph1',
  teamId: 'team1',
  goal: '',
  repo: '',
  conventions: '',
};

function makeNode(id = 'node1'): WorkerNode {
  return {
    id,
    teamId: 'team1',
    graphId: 'graph1',
    type: 'worker',
    name: 'Task',
    status: 'draft',
    priority: 'normal',
    progress: 0,
    prompt: { task: '', refinements: [], comments: [] },
    executor: { provider: 'mock', model: 'mock-v1', skills: [], tools: [], maxIterations: 3 },
    context: { files: [], extra: '' },
    owners: { author: 'admin@example.com', responsible: [] },
    inputs: [],
    output: { summary: '', results: [], commands: [], artifacts: [] },
    history: [],
    version: 1,
    position: { x: 80, y: 80 },
  };
}

function makeProject(extra: Partial<Project> = {}): Project & { revision: number } {
  return {
    version: 1,
    teams,
    graphContexts: [graph],
    nodes: [makeNode()],
    templates: [],
    revision: 1,
    ...extra,
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function ready(p = makeProject()) {
  useStore.setState({ ...p, auth, loading: false, error: null });
  useStore.getState().navigate('team1');
}

const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  await useStore.getState().logout();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// createNode — explicit vs default position
// ---------------------------------------------------------------------------
describe('createNode position', () => {
  test('explicit position is forwarded exactly, including negative/fractional', async () => {
    const p = makeProject();
    let posted: Record<string, unknown> | undefined;
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/nodes' && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return json({ ...makeNode('n2'), position: posted?.position as WorkerNode['position'], revision: 2 });
      }
      if (String(url) === '/api/project') return json(p);
      return json(null);
    };
    ready(p);
    await useStore.getState().createNode('worker', { x: -125.5, y: 314.25 });
    assert.ok(posted, 'POST was made');
    assert.deepEqual(posted?.position, { x: -125.5, y: 314.25 });
  });

  test('omitting position falls back to count-based default', async () => {
    const p = makeProject();
    // project has 1 node already, so next x = 80 + 1*240 = 320
    let posted: Record<string, unknown> | undefined;
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/nodes' && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return json({ ...makeNode('n2'), revision: 2 });
      }
      if (String(url) === '/api/project') return json(p);
      return json(null);
    };
    ready(p);
    await useStore.getState().createNode();
    assert.ok(posted, 'POST was made');
    assert.deepEqual(posted?.position, { x: 320, y: 80 });
  });

  test('zero (falsy) explicit coordinates are forwarded, not overridden by default', async () => {
    const p = makeProject();
    let posted: Record<string, unknown> | undefined;
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/nodes' && init?.method === 'POST') {
        posted = JSON.parse(String(init.body));
        return json({ ...makeNode('n2'), revision: 2 });
      }
      if (String(url) === '/api/project') return json(p);
      return json(null);
    };
    ready(p);
    await useStore.getState().createNode('worker', { x: 0, y: 0 });
    assert.ok(posted);
    assert.deepEqual(posted?.position, { x: 0, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// createTeam — admin guard, no auto-navigation, session isolation
// ---------------------------------------------------------------------------
describe('createTeam', () => {
  test('admin createTeam posts space with supplied coordinates', async () => {
    const p = makeProject();
    let postedBody: Record<string, unknown> | undefined;
    const createdTeam: Team = {
      id: 'new-team',
      name: 'New Team',
      parentId: null,
      kind: 'team',
      space: { x: 10, y: 20, w: 1200, h: 480 },
    };
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/teams' && init?.method === 'POST') {
        postedBody = JSON.parse(String(init.body));
        return json({ ...createdTeam, revision: 2 }, 201);
      }
      if (String(url) === '/api/project') return json(p);
      return json(null);
    };
    ready(p);
    const result = await useStore.getState().createTeam('New Team', 'team', null, { x: 10, y: 20 });
    assert.ok(result, 'returns created team');
    assert.equal(result?.id, 'new-team');
    // space coordinates were sent
    assert.deepEqual(postedBody?.space, { x: 10, y: 20 });
    // no auto-navigation into created team
    assert.notEqual(useStore.getState().selectedTeamId, 'new-team');
  });

  test('non-admin createTeam returns null without posting', async () => {
    const p = makeProject();
    let postCalled = false;
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/teams' && init?.method === 'POST') {
        postCalled = true;
        return json({}, 201);
      }
      if (String(url) === '/api/project') return json(p);
      return json(null);
    };
    useStore.setState({ ...p, auth: editorAuth, loading: false, error: null });
    useStore.getState().navigate('team1');
    const result = await useStore.getState().createTeam('Blocked', 'team');
    assert.equal(result, null);
    assert.equal(postCalled, false);
  });

  test('createTeam without position sends no space key', async () => {
    const p = makeProject();
    let postedBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/teams' && init?.method === 'POST') {
        postedBody = JSON.parse(String(init.body));
        return json({ id: 't2', name: 'T2', parentId: null, kind: 'department', space: { x: 0, y: 0, w: 0, h: 0 }, revision: 2 }, 201);
      }
      if (String(url) === '/api/project') return json(p);
      return json(null);
    };
    ready(p);
    await useStore.getState().createTeam('T2', 'department');
    assert.ok(postedBody);
    assert.equal('space' in postedBody, false);
  });

  test('createTeam returns null and does not set selected team after session change', async () => {
    const p = makeProject();
    const postDeferred = deferred<Response>();
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/teams' && init?.method === 'POST') return postDeferred.promise;
      if (String(url) === '/api/project') return json(p);
      return json(null);
    };
    ready(p);
    const creating = useStore.getState().createTeam('Race', 'team');
    // Log out (session change) while POST is in flight
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await useStore.getState().logout();
    postDeferred.resolve(
      json({ id: 'race-team', name: 'Race', parentId: null, kind: 'team', space: { x: 0, y: 0, w: 1200, h: 480 }, revision: 2 }, 201),
    );
    const result = await creating;
    assert.equal(result, null, 'stale session response yields null');
    assert.equal(useStore.getState().selectedTeamId, null);
  });
});

// ---------------------------------------------------------------------------
// updateTeam — optimistic edit, dirty overlay, role guards
// ---------------------------------------------------------------------------
describe('updateTeam', () => {
  test('optimistic space update is reflected immediately in store', () => {
    const p = makeProject();
    globalThis.fetch = async () => new Response(null, { status: 204 }); // silence timer saves
    ready(p);
    useStore.getState().updateTeam('team1', { space: { x: 55.5, y: -10 } });
    const t = useStore.getState().teams.find((t) => t.id === 'team1')!;
    assert.equal(t.space.x, 55.5);
    assert.equal(t.space.y, -10);
    // w and h preserved
    assert.equal(t.space.w, 1200);
    assert.equal(t.space.h, 480);
  });

  test('viewer cannot updateTeam (no optimistic mutation, no queue)', () => {
    const p = makeProject();
    globalThis.fetch = async () => new Response(null, { status: 204 });
    useStore.setState({ ...p, auth: viewerAuth, loading: false, error: null });
    useStore.getState().navigate('team1');
    useStore.getState().updateTeam('team1', { space: { x: 999 } });
    const t = useStore.getState().teams.find((t) => t.id === 'team1')!;
    assert.equal(t.space.x, 0); // unchanged
  });

  test('editor can updateTeam space but not name', () => {
    const p = makeProject();
    globalThis.fetch = async () => new Response(null, { status: 204 });
    useStore.setState({ ...p, auth: editorAuth, loading: false, error: null });
    useStore.getState().navigate('team1');
    // space change allowed
    useStore.getState().updateTeam('team1', { space: { x: 77 } });
    assert.equal(useStore.getState().teams.find((t) => t.id === 'team1')!.space.x, 77);
    // name change ignored for non-admin
    useStore.getState().updateTeam('team1', { name: 'Hacked' });
    assert.equal(useStore.getState().teams.find((t) => t.id === 'team1')!.name, 'Engineering');
  });

  test('dirty overlay: pending space edit survives an older stale poll', async () => {
    const p = makeProject();
    const oldPoll = deferred<Response>();
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/project') return oldPoll.promise;
      if (init?.method === 'PATCH')
        return json({ ...teams[0], space: { x: 55.5, y: -10, w: 1200, h: 480 }, revision: 3 });
      return json(null);
    };
    ready(p);
    useStore.getState().updateTeam('team1', { space: { x: 55.5, y: -10 } });
    const flush = flushEdits();
    // Stale poll arrives with old data
    oldPoll.resolve(json(p));
    await flush;
    const t = useStore.getState().teams.find((t) => t.id === 'team1')!;
    assert.equal(t.space.x, 55.5, 'dirty overlay preserves x after stale poll');
    assert.equal(t.space.y, -10, 'dirty overlay preserves y after stale poll');
  });

  test('successive partial space patches coalesce: both x and y reach server', async () => {
    const p = makeProject();
    const patches: Record<string, unknown>[] = [];
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return json({ ...teams[0], space: { x: 11, y: 22, w: 1200, h: 480 }, revision: 2 });
      }
      if (String(url) === '/api/project') return json(p);
      return json(null);
    };
    ready(p);
    useStore.getState().updateTeam('team1', { space: { x: 11 } });
    useStore.getState().updateTeam('team1', { space: { y: 22 } });
    await flushEdits();
    // At least one PATCH must carry both x and y (coalesced)
    const combined = patches.find(
      (pp) =>
        pp.space &&
        typeof (pp.space as Record<string, unknown>).x === 'number' &&
        typeof (pp.space as Record<string, unknown>).y === 'number',
    );
    assert.ok(combined, 'coalesced patch contains both x and y');
  });

  test('admin can update team name via updateTeam', () => {
    const p = makeProject();
    globalThis.fetch = async () => new Response(null, { status: 204 });
    ready(p);
    useStore.getState().updateTeam('team1', { name: 'Renamed' });
    assert.equal(useStore.getState().teams.find((t) => t.id === 'team1')!.name, 'Renamed');
  });

  test('sessionRequest is properly guarded: stale team save ignored after logout', async () => {
    const p = makeProject();
    const patchDeferred = deferred<Response>();
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'PATCH') return patchDeferred.promise;
      if (String(url) === '/api/project') return json(p);
      return json(null);
    };
    ready(p);
    useStore.getState().updateTeam('team1', { space: { x: 999 } });
    const flush = flushEdits();
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await useStore.getState().logout();
    // New session
    useStore.setState({ ...p, auth, loading: false, error: null });
    patchDeferred.resolve(
      json({ ...teams[0], space: { x: 999, y: 0, w: 1200, h: 480 }, revision: 5 }),
    );
    await flush.catch(() => {/* expected session guard throw */});
    // New session team should not have been contaminated
    assert.equal(useStore.getState().teams.find((t) => t.id === 'team1')?.space.x ?? 0, 0);
  });
});
