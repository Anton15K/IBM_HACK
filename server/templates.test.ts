import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';
import { BUILTIN_TEMPLATES } from './db.js';
import { validateTemplateDefaults } from './routes/validate.js';

test('built-in automated templates are workers with explicit modes and sufficient turn budgets', () => {
  for (const template of BUILTIN_TEMPLATES) {
    const d = template.defaults;
    assert.equal(d.type, 'worker');
    assert.equal(d.desiredOutput, ['tpl-code-review', 'tpl-investigate'].includes(template.id) ? 'report' : 'patch');
    assert.ok(d.executor!.maxIterations >= 12);
    assert.equal(d.executor!.maxOutputTokens, 4096);
    assert.doesNotMatch(d.prompt!.task!, /commit message/);
    assert.equal(validateTemplateDefaults(d), null);
  }
});

test('template output modes are validated rather than silently granting write access', () => {
  assert.equal(validateTemplateDefaults({ desiredOutput: 'report' }), null);
  assert.equal(validateTemplateDefaults({ desiredOutput: 'patch' }), null);
  assert.match(validateTemplateDefaults({ desiredOutput: 'arbitrary' })!, /desiredOutput/);
});

test('existing organizations receive current built-ins without rewriting nodes or custom templates', async t => {
  const app = buildApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'templates@example.test', password: 'fixture-password-123', name: 'Test', organizationName: 'Test' } });
  assert.equal(registration.statusCode, 201);
  const cookie = registration.headers['set-cookie']!.toString().split(';')[0]!;
  const orgId = registration.json().organization.id;
  const row = app.db.prepare('SELECT data, revision FROM projects WHERE orgId=?').get(orgId)!;
  const saved = JSON.parse(String(row.data));
  saved.templates[0].defaults.type = 'gate';
  saved.templates[0].defaults.executor.maxIterations = 3;
  saved.templates.push({ id: 'custom-review', name: 'My gate', isBuiltIn: false, defaults: { type: 'gate' } });
  app.db.prepare('UPDATE projects SET data=? WHERE orgId=?').run(JSON.stringify(saved), orgId);
  const r = await app.inject({ method: 'GET', url: '/api/project', headers: { cookie } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().templates.find((x: {id: string}) => x.id === 'tpl-code-review').defaults.type, 'worker');
  assert.deepEqual(r.json().templates.at(-1), saved.templates.at(-1));
  assert.deepEqual(r.json().nodes, saved.nodes);
  assert.equal(r.json().revision, Number(row.revision));
  assert.equal(app.db.prepare('SELECT data FROM projects WHERE orgId=?').get(orgId)!.data, JSON.stringify(saved));
});
