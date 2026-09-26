import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';

test('untrusted Host is rejected on reads and writes before route handlers', async (t) => {
  const app = buildApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  let calls = 0;
  app.route({ method: ['GET', 'POST'], url: '/host-probe', handler: () => { calls++; return { ok: true }; } });
  for (const host of ['evil.example:7142', 'localhost.evil.example', '127.0.0.1.evil.example', 'localhost@evil.example', 'localhost:0', 'localhost:65536']) {
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({ method, url: '/host-probe', headers: { host, origin: 'http://localhost:5173' } });
      assert.equal(res.statusCode, 403, `${method} ${host}`);
    }
  }
  assert.equal(calls, 0);
});

test('loopback and Vite proxy Host values remain usable; forwarded Host grants no access', async (t) => {
  const app = buildApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  for (const host of ['localhost', 'localhost:5173', 'LOCALHOST:5190', '127.0.0.1:7142', '[::1]:7142']) {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host, 'x-forwarded-host': 'evil.example' } });
    assert.equal(res.statusCode, 200, host);
  }
  const spoof = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example', 'x-forwarded-host': 'localhost:7142' } });
  assert.equal(spoof.statusCode, 403);
});

test('unexpected failures hide internal paths and secrets while retaining server-error status', async (t) => {
  const app = buildApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  app.get('/unexpected', () => { throw new Error('private /test-only/database.sqlite credential=SYNTHETIC_VALUE'); });
  app.get('/unavailable', () => { throw Object.assign(new Error('upstream private failure'), { statusCode: 503 }); });
  for (const [url, status] of [['/unexpected', 500], ['/unavailable', 503]] as const) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, status);
    assert.deepEqual(res.json(), { error: 'Internal server error' });
  }
});

test('client errors remain useful and trusted-origin login still sets an HttpOnly session', async (t) => {
  const app = buildApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  app.get('/conflict', () => { throw Object.assign(new Error('Revision conflict'), { statusCode: 409 }); });
  const conflict = await app.inject({ method: 'GET', url: '/conflict' });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error, 'Revision conflict');
  const body = { email: 'http-guard@example.test', password: 'fixture-' + 'pass-12345', name: 'HTTP test', organizationName: 'HTTP test org' };
  const rejected = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { host: 'localhost:5173', origin: 'https://evil.example' }, payload: body });
  assert.equal(rejected.statusCode, 403);
  const accepted = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { host: 'localhost:5173', origin: 'http://localhost:5173' }, payload: body });
  assert.equal(accepted.statusCode, 201);
  assert.match(String(accepted.headers['set-cookie']), /HttpOnly/i);
  const cookie = String(accepted.headers['set-cookie']).split(';')[0];
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { host: '127.0.0.1:7142', cookie } });
  assert.equal(me.statusCode, 200);
});
