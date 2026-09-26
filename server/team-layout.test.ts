import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers reused from existing test patterns
// ---------------------------------------------------------------------------
function makeApp() {
  return buildApp({ dbPath: ':memory:', logger: false });
}

async function register(
  app: ReturnType<typeof makeApp>,
  opts: { email?: string; password?: string; organizationName?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: opts.email ?? `u-${randomUUID()}@example.com`,
      password: opts.password ?? 'TestPass1234!',
      name: 'Test User',
      organizationName: opts.organizationName ?? 'TestOrg',
    }),
  });
}

function cookie(res: Awaited<ReturnType<typeof register>>): string {
  const h = res.headers['set-cookie'];
  const raw = Array.isArray(h) ? (h[0] ?? '') : (h ?? '');
  return raw.split(';')[0] ?? '';
}

async function addMember(
  app: ReturnType<typeof makeApp>,
  adminCookie: string,
  email: string,
  role: 'member',
) {
  return app.inject({
    method: 'POST',
    url: '/api/members',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ email, password: 'MemberPass1234!', name: 'Member', role }),
  });
}

async function assignTeamRole(
  app: ReturnType<typeof makeApp>,
  adminCookie: string,
  teamId: string,
  userId: string,
  role: 'viewer' | 'editor',
) {
  return app.inject({
    method: 'PUT',
    url: `/api/teams/${teamId}/members/${userId}`,
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ role }),
  });
}

async function loginAs(app: ReturnType<typeof makeApp>, email: string, password = 'MemberPass1234!') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return cookie(res);
}

// ---------------------------------------------------------------------------
// POST /api/teams — space coordinates
// ---------------------------------------------------------------------------
describe('POST /api/teams space coordinates', () => {
  test('admin POST with explicit x/y persists those coordinates', async () => {
    const app = makeApp();
    const adminRes = await register(app);
    const adminCookie = cookie(adminRes);

    const projRes = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const rootId = projRes.json().teams[0].id;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({
        name: 'Placed Team',
        kind: 'team',
        parentId: rootId,
        space: { x: -125.5, y: 314.25 },
      }),
    });
    assert.equal(createRes.statusCode, 201, createRes.body);
    const created = createRes.json();
    assert.equal(created.space.x, -125.5);
    assert.equal(created.space.y, 314.25);
    // kind defaults for w/h preserved
    assert.equal(created.space.w, 1200);
    assert.equal(created.space.h, 480);

    // GET /project also reflects persisted values
    const proj2 = await app.inject({
      method: 'GET',
      url: '/api/project',
      headers: { cookie: adminCookie },
    });
    const stored = proj2.json().teams.find((t: { id: string }) => t.id === created.id);
    assert.ok(stored, 'team present in project');
    assert.equal(stored.space.x, -125.5);
    assert.equal(stored.space.y, 314.25);

    await app.close();
  });

  test('POST without space uses kind defaults (0,0)', async () => {
    const app = makeApp();
    const adminRes = await register(app);
    const adminCookie = cookie(adminRes);
    const rootId = (await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } })).json().teams[0].id;

    const res = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ name: 'Default', kind: 'department', parentId: rootId }),
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().space.x, 0);
    assert.equal(res.json().space.y, 0);
    await app.close();
  });

  test('POST with invalid space (non-finite x) returns 400', async () => {
    const app = makeApp();
    const adminRes = await register(app);
    const adminCookie = cookie(adminRes);
    const rootId = (await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } })).json().teams[0].id;

    for (const badSpace of [
      { x: 'invalid', y: 0 },
      { x: Infinity, y: 0 },
      { x: 0, w: -1 },
      null,
      42,
      [1, 2],
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/teams',
        headers: { 'content-type': 'application/json', cookie: adminCookie },
        body: JSON.stringify({ name: 'Bad', kind: 'team', parentId: rootId, space: badSpace }),
      });
      assert.equal(res.statusCode, 400, `Expected 400 for space=${JSON.stringify(badSpace)}, got ${res.statusCode}: ${res.body}`);
    }
    await app.close();
  });

  test('POST with null body returns 400', async () => {
    const app = makeApp();
    const adminRes = await register(app);
    const adminCookie = cookie(adminRes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: 'null',
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/teams/:id — space partial update, type/finite guards
// ---------------------------------------------------------------------------
describe('PATCH /api/teams/:id space', () => {
  test('PATCH x preserves existing y, w, h', async () => {
    const app = makeApp();
    const adminRes = await register(app);
    const adminCookie = cookie(adminRes);
    const rootId = (await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } })).json().teams[0].id;

    // Create team at known coordinates
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ name: 'Target', kind: 'team', parentId: rootId, space: { x: 10, y: 20 } }),
    });
    const teamId = createRes.json().id;

    // Patch only x
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ space: { x: 99.9 } }),
    });
    assert.equal(patchRes.statusCode, 200, patchRes.body);
    const t = patchRes.json();
    assert.equal(t.space.x, 99.9);
    assert.equal(t.space.y, 20);   // preserved
    assert.equal(t.space.w, 1200); // preserved
    assert.equal(t.space.h, 480);  // preserved

    await app.close();
  });

  test('PATCH with string space value returns 400', async () => {
    const app = makeApp();
    const adminRes = await register(app);
    const adminCookie = cookie(adminRes);
    const rootId = (await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } })).json().teams[0].id;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ name: 'Val Test', kind: 'team', parentId: rootId }),
    });
    const teamId = createRes.json().id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ space: { x: 'invalid' } }),
    });
    assert.equal(res.statusCode, 400);

    await app.close();
  });

  test('PATCH with null body returns 400', async () => {
    const app = makeApp();
    const adminRes = await register(app);
    const adminCookie = cookie(adminRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const teamId = projRes.json().teams[0].id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}`,
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: 'null',
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('viewer cannot PATCH space', async () => {
    const app = makeApp();
    const adminRes = await register(app, { email: 'adm@space.com' });
    const adminCookie = cookie(adminRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const teamId = projRes.json().teams[0].id;

    const viewerEmail = `v-${randomUUID()}@test.com`;
    const memberRes = await addMember(app, adminCookie, viewerEmail, 'member');
    const viewerId = memberRes.json().id;
    assert.equal(memberRes.statusCode, 201, memberRes.body);
    assert.equal((await assignTeamRole(app, adminCookie, teamId, viewerId, 'viewer')).statusCode, 200);
    const viewerCookie = await loginAs(app, viewerEmail);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/teams/${teamId}`,
      headers: { 'content-type': 'application/json', cookie: viewerCookie },
      body: JSON.stringify({ space: { x: 50 } }),
    });
    assert.equal(res.statusCode, 403);
    await app.close();
  });

  test('viewer cannot POST (create) team', async () => {
    const app = makeApp();
    const adminRes = await register(app, { email: 'adm2@space.com' });
    const adminCookie = cookie(adminRes);
    const projRes = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie: adminCookie } });
    const rootId = projRes.json().teams[0].id;

    const viewerEmail = `v2-${randomUUID()}@test.com`;
    const memberRes = await addMember(app, adminCookie, viewerEmail, 'member');
    const viewerId = memberRes.json().id;
    assert.equal(memberRes.statusCode, 201, memberRes.body);
    assert.equal((await assignTeamRole(app, adminCookie, rootId, viewerId, 'viewer')).statusCode, 200);
    const viewerCookie = await loginAs(app, viewerEmail);

    const res = await app.inject({
      method: 'POST',
      url: '/api/teams',
      headers: { 'content-type': 'application/json', cookie: viewerCookie },
      body: JSON.stringify({ name: 'Evil', kind: 'team', parentId: rootId }),
    });
    assert.equal(res.statusCode, 403);
    await app.close();
  });
});
