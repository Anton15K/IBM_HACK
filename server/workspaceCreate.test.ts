import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, publicCloneUrl } from './workspaceCreate.js';
import { buildApp } from './app.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tw-prepare-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('public clone URL rejects credential, local, protocol and redirect-like inputs', () => {
  for (const url of ['file:///tmp/repo', 'http://github.com/a/b', 'ssh://github.com/a/b',
    'https://127.0.0.1/a/b', 'https://github.com.evil.test/a/b', 'https://user:secret@github.com/a/b',
    'https://github.com/a/b?token=x', 'https://github.com/a/b#x', 'https://github.com:444/a/b',
    'https://github.com/a/%2e%2e/x', 'https://github.com/a/b%0a', 'https://github.com/']) {
    assert.throws(() => publicCloneUrl(url));
  }
  assert.equal(publicCloneUrl('https://github.com/octocat/Hello-World.git'), 'https://github.com/octocat/Hello-World.git');
  assert.equal(publicCloneUrl('https://gitlab.com/team/group/repo'), 'https://gitlab.com/team/group/repo');
});

test('creates folder under allowed root without overwriting existing content', async t => {
  const root = await fixture(t);
  const result = await createWorkspace({ parentPath: root, name: 'My project', kind: 'folder' }, [root]);
  await writeFile(join(result.path, 'keep'), 'preserve');
  await assert.rejects(createWorkspace({ parentPath: root, name: 'My project', kind: 'folder' }, [root]), /already exists/);
  assert.equal(await readFile(join(result.path, 'keep'), 'utf8'), 'preserve');
});

test('rejects traversal, symlink escape, invalid parent and absent roots', async t => {
  const root = await fixture(t);
  const child = join(root, 'allowed'); await mkdir(child);
  const outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(child, 'escape'));
  for (const name of ['..', '../other', '.git', '/tmp/pwn', 'a/b', '-flag', ' bad', 'bad.', '']) {
    await assert.rejects(createWorkspace({ parentPath: child, name, kind: 'folder' }, [child]));
  }
  for (const parentPath of [outside, join(child, 'escape')]) {
    await assert.rejects(createWorkspace({ parentPath, name: 'new', kind: 'folder' }, [child]), /outside/);
  }
  await assert.rejects(createWorkspace({ parentPath: child, name: 'new', kind: 'folder' }, []), /outside/);
  await assert.rejects(createWorkspace({ parentPath: 'relative', name: 'new', kind: 'folder' }, [child]));
});

test('clone returns binding and cleans only its exclusively created target on failure', async t => {
  const root = await fixture(t);
  const body = { parentPath: root, name: 'repo', kind: 'clone', url: 'https://github.com/octocat/Hello-World' };
  let calls = 0;
  const result = await createWorkspace(body, [root], async (url, destination) => {
    calls++; assert.equal(url, body.url); assert.equal(destination, join(root, 'repo'));
    await writeFile(join(destination, 'README.md'), 'fixture'); return 'main';
  });
  assert.deepEqual(result, { path: join(root, 'repo'), branch: 'main', ref: 'HEAD' });
  await assert.rejects(createWorkspace(body, [root], async () => { calls++; return 'main'; }), /already exists/);
  assert.equal(calls, 1);
  await assert.rejects(createWorkspace({ ...body, name: 'failed' }, [root], async (_, destination) => {
    await writeFile(join(destination, 'partial'), 'partial clone'); throw new Error('private upstream diagnostic');
  }), /Clone failed/);
  await assert.rejects(access(join(root, 'failed')));
  assert.equal(await readFile(join(result.path, 'README.md'), 'utf8'), 'fixture');
});

test('prepare endpoint requires authenticated admin and confines writes', async t => {
  const root = await fixture(t);
  const app = buildApp({ dbPath: ':memory:', workspaceBrowseOptions: { allowedRootsOverride: [root] } });
  t.after(() => app.close());
  const request = { method: 'POST' as const, url: '/api/workspace/create', payload: { parentPath: root, name: 'created', kind: 'folder' }, headers: { origin: 'http://localhost:5173' } };
  assert.equal((await app.inject(request)).statusCode, 401);
  const registration = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'prepare@example.test', password: 'DisposableTestPassword!', name: 'Test', organizationName: 'QA' } });
  assert.equal(registration.statusCode, 201);
  const cookie = String(registration.headers['set-cookie']).split(';')[0];
  const authenticated = { ...request, headers: { ...request.headers, cookie } };
  assert.equal((await app.inject(authenticated)).statusCode, 201);
  assert.equal((await app.inject(authenticated)).statusCode, 409);
  app.db.prepare("UPDATE org_memberships SET role='member'").run();
  assert.equal((await app.inject({ ...authenticated, payload: { ...request.payload, name: 'denied' } })).statusCode, 403);
  await assert.rejects(access(join(root, 'denied')));
});
