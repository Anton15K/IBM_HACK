import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHook } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeApp(dbPath = ':memory:') {
  return buildApp({ dbPath, logger: false });
}

async function register(
  app: ReturnType<typeof makeApp>,
  opts: { email?: string; password?: string; name?: string; organizationName?: string } = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({
      email: opts.email ?? `user-${randomUUID()}@example.com`,
      password: opts.password ?? 'SecurePass123!',
      name: opts.name ?? 'Test User',
      organizationName: opts.organizationName ?? 'Test Org',
    }),
  });
  return res;
}

function getCookieHeader(res: Awaited<ReturnType<typeof register>>): string {
  const setCookie = res.headers['set-cookie'];
  if (Array.isArray(setCookie)) return setCookie[0]?.split(';')[0] ?? '';
  return (setCookie ?? '').split(';')[0];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
describe('Health', () => {
  test('GET /api/health returns ok', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Auth: register
// ---------------------------------------------------------------------------
describe('Register', () => {
  test('successful registration returns user+org+role, sets cookie', async () => {
    const app = makeApp();
    const res = await register(app, {
      email: 'alice@example.com',
      password: 'AlicePassword1!',
      name: 'Alice',
      organizationName: 'AliceCorp',
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.user.email, 'alice@example.com');
    assert.equal(body.organization.name, 'AliceCorp');
    assert.equal(body.role, 'admin');
    assert.ok(Array.isArray(body.teamRoles));
    // Cookie set
    const cookie = res.headers['set-cookie'];
    assert.ok(cookie, 'Set-Cookie header present');
    // No password hash in response
    assert.equal(body.user.passwordHash, undefined);
    await app.close();
  });

  test('rejects duplicate email', async () => {
    const app = makeApp();
    await register(app, { email: 'dup@example.com' });
    const res2 = await register(app, { email: 'dup@example.com' });
    assert.equal(res2.statusCode, 409);
    await app.close();
  });

  test('rejects short password', async () => {
    const app = makeApp();
    const res = await register(app, { password: 'short' });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('10'));
    await app.close();
  });

  test('rejects invalid email', async () => {
    const app = makeApp();
    const res = await register(app, { email: 'notanemail' });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('normalises email to lowercase', async () => {
    const app = makeApp();
    const res = await register(app, { email: 'UPPER@Example.COM', password: 'Password1234!' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().user.email, 'upper@example.com');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Auth: login / logout / me
// ---------------------------------------------------------------------------
describe('Login/Logout/Me', () => {
  test('login with correct credentials returns user', async () => {
    const app = makeApp();
    const email = 'login@example.com';
    const password = 'LoginPass1234!';
    await register(app, { email, password });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.email, email);
    assert.ok(res.headers['set-cookie']);
    await app.close();
  });

  test('login with wrong password returns 401 generic error', async () => {
    const app = makeApp();
    const email = 'wrongpw@example.com';
    await register(app, { email, password: 'CorrectPass1!' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email, password: 'WrongPassword1!' }),
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'Invalid credentials');
    await app.close();
  });

  test('unknown user and wrong password both derive a key and return the same failure', async () => {
    const app = makeApp();
    const email = 'timing@example.com';
    await register(app, { email });
    let derivations = 0;
    const hook = createHook({ init(_id, type) { if (type === 'SCRYPTREQUEST') derivations++; } });
    try {
      for (const loginEmail of [email, 'missing@example.com']) {
        derivations = 0;
        hook.enable();
        const res = await app.inject({
          method: 'POST', url: '/api/auth/login',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
          body: JSON.stringify({ email: loginEmail, password: 'incorrect-test-password' }),
        });
        hook.disable();
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.json(), { error: 'Invalid credentials' });
        assert.equal(res.headers['set-cookie'], undefined);
        assert.equal(derivations, 1, `one password derivation required for ${loginEmail}`);
      }
    } finally {
      hook.disable();
      await app.close();
    }
  });

  test('GET /api/auth/me returns 401 without cookie', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('GET /api/auth/me returns user with valid session', async () => {
    const app = makeApp();
    const regRes = await register(app, { email: 'me@example.com', password: 'MePass12345!' });
    const cookieHeader = getCookieHeader(regRes);
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookieHeader },
    });
    assert.equal(meRes.statusCode, 200);
    assert.equal(meRes.json().user.email, 'me@example.com');
    await app.close();
  });

  test('logout clears session', async () => {
    const app = makeApp();
    const regRes = await register(app, { email: 'logout@example.com', password: 'LogoutPass1!' });
    const cookieHeader = getCookieHeader(regRes);
    await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: cookieHeader, origin: 'http://localhost:5173' },
    });
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookieHeader },
    });
    assert.equal(meRes.statusCode, 401);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Organization isolation
// ---------------------------------------------------------------------------
describe('Organization isolation', () => {
  test('cannot access another org project even with a known ID', async () => {
    const app = makeApp();

    // Register two orgs
    const res1 = await register(app, {
      email: 'org1admin@example.com',
      password: 'OrgOnePass123!',
      organizationName: 'Org1',
    });
    const res2 = await register(app, {
      email: 'org2admin@example.com',
      password: 'OrgTwoPass123!',
      organizationName: 'Org2',
    });

    const cookie1 = getCookieHeader(res1);
    const cookie2 = getCookieHeader(res2);

    // Get project for org1
    const proj1 = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: cookie1 },
    });
    assert.equal(proj1.statusCode, 200);
    const teamId1 = proj1.json().teams[0].id;

    // Try to access org1's team from org2 session
    // Org2 admin creates a node with org1's teamId — should 404 (team not in org2)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: cookie2,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        teamId: teamId1,
        graphId: 'fake-graph',
        name: 'Evil Node',
      }),
    });
    assert.ok(createRes.statusCode >= 400, `Expected 4xx, got ${createRes.statusCode}`);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
describe('Members', () => {
  test('admin can create a member', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'admin@members.com',
      password: 'AdminPass1234!',
      organizationName: 'MemberOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/members',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        email: 'newmember@members.com',
        password: 'MemberPass1234!',
        name: 'New Member',
        role: 'member',
      }),
    });
    assert.equal(createRes.statusCode, 201);
    assert.equal(createRes.json().role, 'member');
    await app.close();
  });

  test('non-admin cannot list or create members', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'adminx@test.com',
      password: 'AdminXPass1!',
      organizationName: 'AccessTestOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    // Create a regular member
    await app.inject({
      method: 'POST',
      url: '/api/members',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        email: 'member2@test.com',
        password: 'Member2Pass1!',
        name: 'Member Two',
        role: 'member',
      }),
    });
    // Login as member
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'member2@test.com', password: 'Member2Pass1!' }),
    });
    const memberCookie = getCookieHeader(loginRes);
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { cookie: memberCookie },
    });
    assert.equal(listRes.statusCode, 403);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------
describe('Teams', () => {
  test('admin can create team', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'ta@teams.com',
      password: 'TeamsPass1234!',
      organizationName: 'TeamOrg',
    });
    const adminCookie = getCookieHeader(adminRes);

    // Get root team id for parent
    const projRes = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const rootTeamId = projRes.json().teams[0].id;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ name: 'Engineering', parentId: rootTeamId, kind: 'team' }),
    });
    assert.equal(createRes.statusCode, 201);
    assert.equal(createRes.json().name, 'Engineering');
    // Team type should have a graph context
    const proj2 = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const newTeamId = createRes.json().id;
    const graph = proj2.json().graphContexts.find((g: { teamId: string }) => g.teamId === newTeamId);
    assert.ok(graph, 'Graph context created for new team');
    await app.close();
  });

  test('rejects hierarchy cycle', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'cycle@teams.com',
      password: 'CyclePass1234!',
      organizationName: 'CycleOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const projRes = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const rootTeamId = projRes.json().teams[0].id;

    // Create child team
    const childRes = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ name: 'Child', parentId: rootTeamId, kind: 'department' }),
    });
    const childId = childRes.json().id;

    // Try to set root's parent to child (cycle)
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${rootTeamId}`,
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ parentId: childId }),
    });
    assert.equal(patchRes.statusCode, 400);
    assert.ok(patchRes.json().error.toLowerCase().includes('cycle'));
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------
describe('Nodes', () => {
  async function setupOrgWithTeamAndGraph(app: ReturnType<typeof makeApp>, email: string) {
    const adminRes = await register(app, {
      email,
      password: 'NodeTestPass1!',
      organizationName: 'NodeTestOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const projRes = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const proj = projRes.json();
    const teamId = proj.teams[0].id;
    const graphId = proj.graphContexts[0].id;
    return { adminCookie, teamId, graphId };
  }

  test('admin can create a node with correct graph reference', async () => {
    const app = makeApp();
    const { adminCookie, teamId, graphId } = await setupOrgWithTeamAndGraph(app, 'nc@test.com');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ teamId, graphId, name: 'My Node' }),
    });
    assert.equal(createRes.statusCode, 201);
    const node = createRes.json();
    assert.equal(node.graphId, graphId);
    assert.equal(node.teamId, teamId);
    assert.equal(node.status, 'draft');
    assert.equal(node.progress, 0);
    assert.deepEqual(node.output, { summary: '', results: [], commands: [], artifacts: [] });
    assert.deepEqual(node.history, []);
    await app.close();
  });

  test('cannot forge output/status/history/progress', async () => {
    const app = makeApp();
    const { adminCookie, teamId, graphId } = await setupOrgWithTeamAndGraph(app, 'forge@test.com');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ teamId, graphId, name: 'Forge Test' }),
    });
    const nodeId = createRes.json().id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeId}`,
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ status: 'done', progress: 100, output: { summary: 'hacked' } }),
    });
    assert.equal(patchRes.statusCode, 400);
    await app.close();
  });

  test('cannot change node ownership fields', async () => {
    const app = makeApp();
    const { adminCookie, teamId, graphId } = await setupOrgWithTeamAndGraph(app, 'own@test.com');
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ teamId, graphId, name: 'Own Test' }),
    });
    const nodeId = createRes.json().id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeId}`,
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ teamId: 'other-team', graphId: 'other-graph' }),
    });
    assert.equal(patchRes.statusCode, 400);
    await app.close();
  });

  test('input cycle detection', async () => {
    const app = makeApp();
    const { adminCookie, teamId, graphId } = await setupOrgWithTeamAndGraph(app, 'cycle@nodes.com');

    // Create nodeA
    const nodeARes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ teamId, graphId, name: 'Node A' }),
    });
    const nodeAId = nodeARes.json().id;

    // Create nodeB with input from nodeA
    const nodeBRes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        teamId, graphId, name: 'Node B',
        inputs: [{ fromNodeId: nodeAId, enabled: true }],
      }),
    });
    const nodeBId = nodeBRes.json().id;

    // Try to set nodeA's input to nodeB (creates A->B->A cycle)
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeAId}`,
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ inputs: [{ fromNodeId: nodeBId, enabled: true }] }),
    });
    assert.equal(patchRes.statusCode, 400);
    assert.ok(patchRes.json().error.toLowerCase().includes('cycle'));
    await app.close();
  });

  test('node deletion removes references in same org', async () => {
    const app = makeApp();
    const { adminCookie, teamId, graphId } = await setupOrgWithTeamAndGraph(app, 'del@nodes.com');

    const nodeARes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ teamId, graphId, name: 'Node A' }),
    });
    const nodeAId = nodeARes.json().id;

    await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        teamId, graphId, name: 'Node B',
        inputs: [{ fromNodeId: nodeAId, enabled: true }],
      }),
    });

    // Delete nodeA
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/nodes/${nodeAId}`,
      headers: { cookie: adminCookie, origin: 'http://localhost:5173' },
    });
    assert.equal(delRes.statusCode, 204);

    // Check nodeB no longer has nodeA as input
    const projRes = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const nodeB = projRes.json().nodes.find((n: { name: string }) => n.name === 'Node B');
    assert.ok(nodeB);
    assert.equal(nodeB.inputs.length, 0);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Access control: viewer denied mutation, editor can
// ---------------------------------------------------------------------------
describe('Team access control', () => {
  test('viewer cannot mutate nodes', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'admin@access.com',
      password: 'AccessAdmin1!',
      organizationName: 'AccessOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const adminUserId = adminRes.json().user.id;

    // Get team/graph info
    const projRes = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const teamId = projRes.json().teams[0].id;
    const graphId = projRes.json().graphContexts[0].id;

    // Create viewer member
    await app.inject({
      method: 'POST',
      url: '/api/members',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        email: 'viewer@access.com',
        password: 'ViewerPass1234!',
        name: 'Viewer',
        role: 'member',
      }),
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { cookie: adminCookie },
    });
    const viewerUser = listRes.json().find((m: { email: string }) => m.email === 'viewer@access.com');

    // Assign viewer role on team
    await app.inject({
      method: 'PUT',
      url: `/api/teams/${teamId}/members/${viewerUser.id}`,
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ role: 'viewer' }),
    });

    // Login as viewer
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'viewer@access.com', password: 'ViewerPass1234!' }),
    });
    const viewerCookie = getCookieHeader(loginRes);

    // Viewer tries to create node — should fail
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: viewerCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ teamId, graphId, name: 'Evil Node' }),
    });
    assert.equal(createRes.statusCode, 403);
    await app.close();
  });

  test('editor on parent team (department) can edit child team nodes (inherited access)', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'admin@inherit.com',
      password: 'InheritAdmin1!',
      organizationName: 'InheritOrg',
    });
    const adminCookie = getCookieHeader(adminRes);

    // Get root team
    const projRes = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const rootTeamId = projRes.json().teams[0].id;

    // Create a department and child team
    const deptRes = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ name: 'Engineering Dept', parentId: rootTeamId, kind: 'department' }),
    });
    const deptId = deptRes.json().id;

    const childTeamRes = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ name: 'Backend Team', parentId: deptId, kind: 'team' }),
    });
    const childTeamId = childTeamRes.json().id;

    // Get child team's graph
    const proj2Res = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const childGraph = proj2Res.json().graphContexts.find(
      (g: { teamId: string }) => g.teamId === childTeamId
    );
    const childGraphId = childGraph.id;

    // Create editor member
    await app.inject({
      method: 'POST',
      url: '/api/members',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        email: 'editor@inherit.com',
        password: 'EditorPass1234!',
        name: 'Editor',
        role: 'member',
      }),
    });
    const membersRes = await app.inject({
      method: 'GET',
      url: '/api/members',
      headers: { cookie: adminCookie },
    });
    const editorUser = membersRes.json().find((m: { email: string }) => m.email === 'editor@inherit.com');

    // Assign editor role on the DEPARTMENT (parent), not the child team
    await app.inject({
      method: 'PUT',
      url: `/api/teams/${deptId}/members/${editorUser.id}`,
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ role: 'editor' }),
    });

    // Login as editor
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'editor@inherit.com', password: 'EditorPass1234!' }),
    });
    const editorCookie = getCookieHeader(loginRes);

    // Editor should be able to create a node in the child team via inherited editor access
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: editorCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ teamId: childTeamId, graphId: childGraphId, name: 'Inherited Node' }),
    });
    assert.equal(createRes.statusCode, 201, `Expected 201, got ${createRes.statusCode}: ${createRes.body}`);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// File database persistence (restart test)
// ---------------------------------------------------------------------------
describe('File database persistence', () => {
  test('project survives closing and reopening database', async () => {
    const dbPath = join(tmpdir(), `tw-test-${randomUUID()}.db`);

    // Create org and node
    const app1 = buildApp({ dbPath, logger: false });
    const regRes = await register(app1, {
      email: 'persist@test.com',
      password: 'PersistPass1234!',
      organizationName: 'PersistOrg',
    });
    const cookie1 = getCookieHeader(regRes);
    const projRes = await app1.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: cookie1 },
    });
    const teamId = projRes.json().teams[0].id;
    const graphId = projRes.json().graphContexts[0].id;

    await app1.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: cookie1,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ teamId, graphId, name: 'Persistent Node' }),
    });

    await app1.close();

    // Reopen database in a new app
    const app2 = buildApp({ dbPath, logger: false });

    // Login again (sessions are lost since in-memory? No, file db — session persists)
    const loginRes = await app2.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'persist@test.com', password: 'PersistPass1234!' }),
    });
    const cookie2 = getCookieHeader(loginRes);

    const projRes2 = await app2.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: cookie2 },
    });
    const nodes = projRes2.json().nodes;
    assert.ok(nodes.some((n: { name: string }) => n.name === 'Persistent Node'), 'Node persisted across restart');
    await app2.close();
  });
});

// ---------------------------------------------------------------------------
// CORS / Origin rejection
// ---------------------------------------------------------------------------
describe('Origin check', () => {
  test('POST with untrusted Origin is rejected', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: {
        'content-type': 'application/json',
        origin: 'http://evil.example.com',
      },
      body: JSON.stringify({
        email: 'evil@evil.com',
        password: 'EvilPass1234!',
        name: 'Evil',
        organizationName: 'EvilOrg',
      }),
    });
    assert.equal(res.statusCode, 403);
    await app.close();
  });

  test('POST without Origin header is allowed (e.g. server-to-server)', async () => {
    const app = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'internal@example.com',
        password: 'InternalPass1!',
        name: 'Internal',
        organizationName: 'InternalOrg',
      }),
    });
    assert.equal(res.statusCode, 201);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Input refers to non-existent node
// ---------------------------------------------------------------------------
describe('Node input validation', () => {
  test('input referencing non-existent node returns 400', async () => {
    const app = makeApp();
    const regRes = await register(app, {
      email: 'valinp@test.com',
      password: 'ValPass1234!',
      organizationName: 'ValOrg',
    });
    const adminCookie = getCookieHeader(regRes);
    const projRes = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const teamId = projRes.json().teams[0].id;
    const graphId = projRes.json().graphContexts[0].id;

    const res = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        teamId, graphId, name: 'Node with bad input',
        inputs: [{ fromNodeId: 'nonexistent-id', enabled: true }],
      }),
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Regression: malformed create+patch => 400, prior node preserved
// ---------------------------------------------------------------------------
describe('Node validation regressions', () => {
  async function setupNode(app: ReturnType<typeof makeApp>, email: string) {
    const adminRes = await register(app, {
      email,
      password: 'RegPass1234!',
      organizationName: 'RegOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const projRes = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const teamId = projRes.json().teams[0].id;
    const graphId = projRes.json().graphContexts[0].id;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ teamId, graphId, name: 'Baseline Node' }),
    });
    assert.equal(createRes.statusCode, 201);
    return { adminCookie, teamId, graphId, nodeId: createRes.json().id, email };
  }

  test('malformed executor on create => 400, no node persisted', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'malexec@test.com',
      password: 'RegPass1234!',
      organizationName: 'MalExecOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const teamId = projRes.json().teams[0].id;
    const graphId = projRes.json().graphContexts[0].id;
    const countBefore = projRes.json().nodes.length;

    const res = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({
        teamId, graphId, name: 'Bad Node',
        executor: { provider: 'invalid-provider', model: 'm', skills: [], tools: [], maxIterations: 5 },
      }),
    });
    assert.equal(res.statusCode, 400);

    // Confirm no node was added
    const proj2 = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    assert.equal(proj2.json().nodes.length, countBefore);
    await app.close();
  });

  test('malformed patch => 400, prior node state preserved', async () => {
    const app = makeApp();
    const { adminCookie, nodeId } = await setupNode(app, 'malpatch@test.com');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ executor: { provider: 'bob', model: 'm', skills: 'not-an-array', tools: [], maxIterations: 5 } }),
    });
    assert.equal(patchRes.statusCode, 400);

    // Verify the node is unchanged
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const node = projRes.json().nodes.find((n: { id: string }) => n.id === nodeId);
    assert.ok(node, 'node still exists');
    assert.deepEqual(node.executor.skills, [], 'skills array unchanged');
    await app.close();
  });

  test('forged create fields (id, status, version, inboxMeta) => 400', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'forgefields@test.com',
      password: 'RegPass1234!',
      organizationName: 'ForgeOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const teamId = projRes.json().teams[0].id;
    const graphId = projRes.json().graphContexts[0].id;

    for (const forgedField of ['id', 'status', 'version', 'history', 'progress', 'output']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/nodes',
        headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
        body: JSON.stringify({ teamId, graphId, name: 'Forge Test', [forgedField]: 'hacked' }),
      });
      assert.equal(res.statusCode, 400, `Expected 400 for forged field '${forgedField}', got ${res.statusCode}`);
    }
    await app.close();
  });

  test('author is set to authenticated user email on create; cannot change via PATCH', async () => {
    const app = makeApp();
    const email = 'author@test.com';
    const adminRes = await register(app, {
      email,
      password: 'AuthorPass1!',
      organizationName: 'AuthorOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const teamId = projRes.json().teams[0].id;
    const graphId = projRes.json().graphContexts[0].id;

    // Create node with explicit owners.author (should be overridden)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/nodes',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({
        teamId, graphId, name: 'Author Node',
        owners: { author: 'hacker@evil.com', responsible: [] },
      }),
    });
    assert.equal(createRes.statusCode, 201);
    assert.equal(createRes.json().owners.author, email, 'author overridden to authenticated user');

    const nodeId = createRes.json().id;

    // Try to change author via PATCH
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ owners: { author: 'someone-else@test.com', responsible: [] } }),
    });
    assert.equal(patchRes.statusCode, 400);
    await app.close();
  });

  test('desiredOutput roundtrip and null-clear', async () => {
    const app = makeApp();
    const { adminCookie, nodeId } = await setupNode(app, 'desiredout@test.com');

    // Set desiredOutput
    const patch1 = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ desiredOutput: 'pull_request' }),
    });
    assert.equal(patch1.statusCode, 200);
    assert.equal(patch1.json().desiredOutput, 'pull_request');

    // Clear desiredOutput with null (treated as absent/cleared)
    const patch2 = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ desiredOutput: null }),
    });
    assert.equal(patch2.statusCode, 200);
    assert.ok(patch2.json().desiredOutput == null, 'desiredOutput cleared');
    await app.close();
  });

  test('workspace roundtrip on node: set, persist, null-clear', async () => {
    const app = makeApp();
    const { adminCookie, nodeId } = await setupNode(app, 'ws-node@test.com');

    const ws = { path: '/home/user/repo', branch: 'main', ref: 'HEAD' };
    const patch1 = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ workspace: ws }),
    });
    assert.equal(patch1.statusCode, 200);
    assert.deepEqual(patch1.json().workspace, ws);

    // null clears the workspace override
    const patch2 = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ workspace: null }),
    });
    assert.equal(patch2.statusCode, 200);
    assert.ok(patch2.json().workspace == null, 'workspace cleared');
    await app.close();
  });

  test('invalid workspace shape => 400', async () => {
    const app = makeApp();
    const { adminCookie, nodeId } = await setupNode(app, 'badws@test.com');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ workspace: { path: '', branch: 'main', ref: 'HEAD' } }),
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('invalid maxCost => 400', async () => {
    const app = makeApp();
    const { adminCookie, nodeId } = await setupNode(app, 'maxcost@test.com');

    for (const badVal of [0, -1, 4, 'high']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/nodes/${nodeId}`,
        headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
        body: JSON.stringify({ executor: { provider: 'bob', model: 'm', skills: [], tools: [], maxIterations: 5, maxCost: badVal } }),
      });
      assert.equal(res.statusCode, 400, `Expected 400 for maxCost=${badVal}`);
    }

    // Valid maxCost should succeed
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/nodes/${nodeId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ executor: { provider: 'bob', model: 'm', skills: [], tools: [], maxIterations: 5, maxCost: 1.5 } }),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().executor.maxCost, 1.5);
    await app.close();
  });

  test('enabled cycle denied but disabled feedback edge allowed', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'disablededge@test.com',
      password: 'DisabledEdge1!',
      organizationName: 'DisabledOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const teamId = projRes.json().teams[0].id;
    const graphId = projRes.json().graphContexts[0].id;

    // Create nodeA
    const nodeARes = await app.inject({
      method: 'POST', url: '/api/nodes',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ teamId, graphId, name: 'Node A' }),
    });
    const nodeAId = nodeARes.json().id;

    // Create nodeB with enabled input from nodeA
    const nodeBRes = await app.inject({
      method: 'POST', url: '/api/nodes',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ teamId, graphId, name: 'Node B', inputs: [{ fromNodeId: nodeAId, enabled: true }] }),
    });
    const nodeBId = nodeBRes.json().id;

    // Enabled cycle => 400
    const cycleRes = await app.inject({
      method: 'PATCH', url: `/api/nodes/${nodeAId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ inputs: [{ fromNodeId: nodeBId, enabled: true }] }),
    });
    assert.equal(cycleRes.statusCode, 400, 'enabled cycle should be rejected');

    // Disabled feedback edge (back-edge) => 200 (allowed)
    const disabledRes = await app.inject({
      method: 'PATCH', url: `/api/nodes/${nodeAId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ inputs: [{ fromNodeId: nodeBId, enabled: false }] }),
    });
    assert.equal(disabledRes.statusCode, 200, 'disabled feedback edge should be allowed');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Regression: nearest viewer overrides parent editor
// ---------------------------------------------------------------------------
describe('Nearest ancestor role wins', () => {
  test('viewer on child team overrides inherited editor from parent', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'admin@nearviewer.com',
      password: 'NearViewer1!',
      organizationName: 'NearViewerOrg',
    });
    const adminCookie = getCookieHeader(adminRes);

    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const rootTeamId = projRes.json().teams[0].id;

    // Create dept and child team
    const deptRes = await app.inject({
      method: 'POST', url: '/api/teams',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ name: 'Dept', parentId: rootTeamId, kind: 'department' }),
    });
    const deptId = deptRes.json().id;

    const childRes = await app.inject({
      method: 'POST', url: '/api/teams',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ name: 'Child Team', parentId: deptId, kind: 'team' }),
    });
    const childTeamId = childRes.json().id;

    const proj2 = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const childGraphId = proj2.json().graphContexts.find((g: { teamId: string }) => g.teamId === childTeamId).id;

    // Create member
    await app.inject({
      method: 'POST', url: '/api/members',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'dualrole@test.com', password: 'DualRolePass1!', name: 'Dual', role: 'member' }),
    });
    const membersRes = await app.inject({ method: 'GET', url: '/api/members', headers: { cookie: adminCookie } });
    const member = membersRes.json().find((m: { email: string }) => m.email === 'dualrole@test.com');

    // Assign editor on parent dept
    await app.inject({
      method: 'PUT', url: `/api/teams/${deptId}/members/${member.id}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ role: 'editor' }),
    });

    // Assign viewer on child team (nearest wins => viewer)
    await app.inject({
      method: 'PUT', url: `/api/teams/${childTeamId}/members/${member.id}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ role: 'viewer' }),
    });

    const loginRes = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'dualrole@test.com', password: 'DualRolePass1!' }),
    });
    const memberCookie = getCookieHeader(loginRes);

    // With viewer on child team, mutation should fail (403)
    const createRes = await app.inject({
      method: 'POST', url: '/api/nodes',
      headers: { 'content-type': 'application/json', cookie: memberCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ teamId: childTeamId, graphId: childGraphId, name: 'Should Fail' }),
    });
    assert.equal(createRes.statusCode, 403, 'viewer on child overrides editor from parent');
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Regression: viewer cannot create templates; editor can
// ---------------------------------------------------------------------------
describe('Template access control', () => {
  test('pure viewer cannot create template', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'admin@tpltmpl.com',
      password: 'TplAdminPass1!',
      organizationName: 'TplOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const teamId = projRes.json().teams[0].id;

    // Create viewer member
    await app.inject({
      method: 'POST', url: '/api/members',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'viewer@tpltmpl.com', password: 'ViewerTplPass1!', name: 'Viewer', role: 'member' }),
    });
    const membersRes = await app.inject({ method: 'GET', url: '/api/members', headers: { cookie: adminCookie } });
    const viewer = membersRes.json().find((m: { email: string }) => m.email === 'viewer@tpltmpl.com');

    await app.inject({
      method: 'PUT', url: `/api/teams/${teamId}/members/${viewer.id}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ role: 'viewer' }),
    });

    const loginRes = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'viewer@tpltmpl.com', password: 'ViewerTplPass1!' }),
    });
    const viewerCookie = getCookieHeader(loginRes);

    const createRes = await app.inject({
      method: 'POST', url: '/api/templates',
      headers: { 'content-type': 'application/json', cookie: viewerCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ name: 'Viewer Template' }),
    });
    assert.equal(createRes.statusCode, 403);
    await app.close();
  });

  test('invalid template defaults (forbidden key) => 400', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'admin@tplinvalid.com',
      password: 'TplInvPass1!',
      organizationName: 'TplInvOrg',
    });
    const adminCookie = getCookieHeader(adminRes);

    const res = await app.inject({
      method: 'POST', url: '/api/templates',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({
        name: 'Bad Tpl',
        defaults: { status: 'done', type: 'worker' },
      }),
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('member with no team role cannot create template', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'admin@notplain.com',
      password: 'NotPlainPass1!',
      organizationName: 'NoTplOrg',
    });
    const adminCookie = getCookieHeader(adminRes);

    // Create member without any team role assignment
    await app.inject({
      method: 'POST', url: '/api/members',
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'notplain@notplain.com', password: 'NotPlainPass1!', name: 'NoPerm', role: 'member' }),
    });

    const loginRes = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ email: 'notplain@notplain.com', password: 'NotPlainPass1!' }),
    });
    const memberCookie = getCookieHeader(loginRes);

    const createRes = await app.inject({
      method: 'POST', url: '/api/templates',
      headers: { 'content-type': 'application/json', cookie: memberCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ name: 'Sneaky Template' }),
    });
    assert.equal(createRes.statusCode, 403);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Regression: workspace roundtrip on graph context
// ---------------------------------------------------------------------------
describe('Graph workspace binding', () => {
  test('workspace set, persisted, and null-cleared on graph', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'admin@gwsbind.com',
      password: 'GwsBindPass1!',
      organizationName: 'GwsOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const graphId = projRes.json().graphContexts[0].id;

    const ws = { path: '/repos/myproject', branch: 'develop', ref: 'HEAD' };

    const patch1 = await app.inject({
      method: 'PATCH', url: `/api/graphs/${graphId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ workspace: ws }),
    });
    assert.equal(patch1.statusCode, 200);
    assert.deepEqual(patch1.json().workspace, ws);

    // Clear it
    const patch2 = await app.inject({
      method: 'PATCH', url: `/api/graphs/${graphId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ workspace: null }),
    });
    assert.equal(patch2.statusCode, 200);
    assert.ok(patch2.json().workspace == null, 'workspace cleared from graph');
    await app.close();
  });

  test('invalid graph workspace => 400', async () => {
    const app = makeApp();
    const adminRes = await register(app, {
      email: 'admin@gwsinvalid.com',
      password: 'GwsInvPass1!',
      organizationName: 'GwsInvOrg',
    });
    const adminCookie = getCookieHeader(adminRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const graphId = projRes.json().graphContexts[0].id;

    const res = await app.inject({
      method: 'PATCH', url: `/api/graphs/${graphId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ workspace: { path: '/repo', branch: '', ref: 'HEAD' } }),
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Regression: Team.kind set on creation
// ---------------------------------------------------------------------------
describe('Team.kind', () => {
  test('registration sets root team kind to organization', async () => {
    const app = makeApp();
    const regRes = await register(app, { email: 'kindtest@kind.com', password: 'KindPass1234!', organizationName: 'KindOrg' });
    const cookie = getCookieHeader(regRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie } });
    const rootTeam = projRes.json().teams[0];
    assert.equal(rootTeam.kind, 'organization');
    await app.close();
  });

  test('POST /api/teams creates team with correct kind', async () => {
    const app = makeApp();
    const regRes = await register(app, { email: 'kindteam@kind.com', password: 'KindPass1234!', organizationName: 'KindOrg2' });
    const cookie = getCookieHeader(regRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie } });
    const rootTeamId = projRes.json().teams[0].id;

    const deptRes = await app.inject({
      method: 'POST', url: '/api/teams',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ name: 'Engineering', parentId: rootTeamId, kind: 'department' }),
    });
    assert.equal(deptRes.statusCode, 201);
    assert.equal(deptRes.json().kind, 'department');

    const teamRes = await app.inject({
      method: 'POST', url: '/api/teams',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost:5173' },
      body: JSON.stringify({ name: 'Backend', parentId: deptRes.json().id, kind: 'team' }),
    });
    assert.equal(teamRes.statusCode, 201);
    assert.equal(teamRes.json().kind, 'team');
    await app.close();
  });
});

