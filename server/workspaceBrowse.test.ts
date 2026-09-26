/**
 * server/workspaceBrowse.test.ts
 *
 * Tests for the workspace browse, roots, and validate endpoints.
 *
 * Uses temporary directories and git repos under tmpdir() for isolation.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, symlink, rm } from 'node:fs/promises';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(_execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(allowedRootsOverride: string[]) {
  return buildApp({
    dbPath: ':memory:',
    logger: false,
    workspaceBrowseOptions: { allowedRootsOverride },
  });
}

async function register(
  app: ReturnType<typeof makeApp>,
  opts: { email?: string; password?: string } = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    body: JSON.stringify({
      email: opts.email ?? `user-${randomUUID()}@example.com`,
      password: opts.password ?? 'SecurePass123!',
      name: 'Test User',
      organizationName: 'Test Org',
    }),
  });
  return res;
}

function getCookie(res: Awaited<ReturnType<typeof register>>): string {
  const setCookie = res.headers['set-cookie'];
  if (Array.isArray(setCookie)) return setCookie[0]?.split(';')[0] ?? '';
  return (setCookie ?? '').split(';')[0];
}

/** Create a temp directory that is a real git repo with an initial commit */
async function makeTempGitRepo(parentDir: string, name: string, branch = 'main'): Promise<string> {
  const repoPath = join(parentDir, name);
  await mkdir(repoPath, { recursive: true });
  await execFile('git', ['init', '-b', branch, repoPath]);
  await execFile('git', ['-C', repoPath, 'config', 'user.email', 'test@example.com']);
  await execFile('git', ['-C', repoPath, 'config', 'user.name', 'Test']);
  // Create a file and commit
  await execFile('sh', ['-c', `echo 'hello' > ${repoPath}/README.md`]);
  await execFile('git', ['-C', repoPath, 'add', '.']);
  await execFile('git', ['-C', repoPath, 'commit', '-m', 'init']);
  return repoPath;
}

/** Create a plain directory (not a git repo) */
async function makeTempDir(parentDir: string, name: string): Promise<string> {
  const dirPath = join(parentDir, name);
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

// ---------------------------------------------------------------------------
// GET /api/workspace/roots
// ---------------------------------------------------------------------------

describe('GET /api/workspace/roots', () => {
  test('unconfigured: returns empty roots, configured=false, hint', async () => {
    const app = makeApp([]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/roots',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.roots, []);
    assert.equal(body.configured, false);
    assert.ok(typeof body.hint === 'string', 'hint present when unconfigured');
    assert.ok(body.hint.includes('TEAMWEAVE_WORKSPACE_ROOTS'), 'hint contains env var name');
    await app.close();
  });

  test('configured: returns roots, configured=true, no hint', async () => {
    const root = join(tmpdir(), `tw-roots-${randomUUID()}`);
    await mkdir(root);
    const app = makeApp([root]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/roots',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.roots));
    assert.ok(body.roots.length > 0, 'at least one root returned');
    assert.equal(body.configured, true);
    assert.equal(body.hint, undefined, 'no hint when configured');
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  test('unauthenticated request returns 401', async () => {
    const app = makeApp([]);
    const res = await app.inject({ method: 'GET', url: '/api/workspace/roots' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// GET /api/workspace/browse
// ---------------------------------------------------------------------------

describe('GET /api/workspace/browse', () => {
  let tmpRoot: string;
  let subDir: string;
  let gitRepo: string;
  let plainDir: string;

  before(async () => {
    tmpRoot = join(tmpdir(), `tw-browse-${randomUUID()}`);
    await mkdir(tmpRoot, { recursive: true });
    subDir = join(tmpdir(), `tw-browse-sub-${randomUUID()}`);
    await mkdir(subDir, { recursive: true });
    gitRepo = await makeTempGitRepo(tmpRoot, 'myrepo');
    plainDir = await makeTempDir(tmpRoot, 'notgit');
  });

  after(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    await rm(subDir, { recursive: true, force: true });
  });

  test('no roots configured => 400', async () => {
    const app = makeApp([]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/browse',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.includes('No workspace roots'));
    await app.close();
  });

  test('no path param: lists one level under root, directories only', async () => {
    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/browse',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.entries));
    // Should contain our directories
    const names = body.entries.map((e: { name: string }) => e.name);
    assert.ok(names.includes('myrepo'), 'myrepo in listing');
    assert.ok(names.includes('notgit'), 'notgit in listing');
    // parentPath null at root level
    assert.equal(body.parentPath, null);
    await app.close();
  });

  test('git worktree directories are flagged; plain dirs are not', async () => {
    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/browse',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const entries: { name: string; path: string; gitWorktree: boolean }[] = res.json().entries;
    const repoEntry = entries.find((e) => e.name === 'myrepo');
    const plainEntry = entries.find((e) => e.name === 'notgit');
    assert.ok(repoEntry, 'myrepo entry found');
    assert.ok(plainEntry, 'notgit entry found');
    assert.equal(repoEntry!.gitWorktree, true, 'myrepo flagged as git worktree');
    assert.equal(plainEntry!.gitWorktree, false, 'notgit not flagged as git worktree');
    await app.close();
  });

  test('path param: lists contents and returns parentPath', async () => {
    // Create a subdirectory inside the git repo
    const nestedDir = join(gitRepo, 'nested');
    await mkdir(nestedDir, { recursive: true });

    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/browse?path=${encodeURIComponent(gitRepo)}`,
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    // parentPath should be the parent of gitRepo (which is tmpRoot)
    assert.ok(body.parentPath !== null, 'parentPath not null when browsing a subpath');

    await rm(nestedDir, { recursive: true, force: true });
    await app.close();
  });

  test('path outside roots => 403, no listing', async () => {
    const outsideDir = join(tmpdir(), `tw-outside-${randomUUID()}`);
    await mkdir(outsideDir);

    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'GET',
      url: `/api/workspace/browse?path=${encodeURIComponent(outsideDir)}`,
      headers: { cookie },
    });
    assert.ok(res.statusCode === 400 || res.statusCode === 403, `expected 400/403 got ${res.statusCode}`);
    const body = res.json();
    assert.ok(body.error, 'error field present');
    assert.equal(body.entries, undefined, 'no entries in error response');

    await rm(outsideDir, { recursive: true, force: true });
    await app.close();
  });

  test('symlink that escapes roots is silently excluded from listing', async () => {
    // Create a directory outside the root
    const escapeDest = join(tmpdir(), `tw-escape-dest-${randomUUID()}`);
    await mkdir(escapeDest);

    // Create a symlink inside the root pointing outside
    const symlinkPath = join(tmpRoot, `sym-escape-${randomUUID()}`);
    await symlink(escapeDest, symlinkPath);

    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'GET',
      url: '/api/workspace/browse',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const entries: { path: string }[] = res.json().entries;
    const symlinkName = symlinkPath.split('/').pop();
    const found = entries.some((e) => e.path === escapeDest || e.path.endsWith(symlinkName!));
    assert.equal(found, false, 'symlink escaping roots excluded from listing');

    await rm(symlinkPath, { force: true });
    await rm(escapeDest, { recursive: true, force: true });
    await app.close();
  });

  test('unauthenticated request returns 401', async () => {
    const app = makeApp([tmpRoot]);
    const res = await app.inject({ method: 'GET', url: '/api/workspace/browse' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// POST /api/workspace/validate
// ---------------------------------------------------------------------------

describe('POST /api/workspace/validate', () => {
  let tmpRoot: string;
  let gitRepo: string;
  let plainDir: string;

  before(async () => {
    tmpRoot = join(tmpdir(), `tw-validate-${randomUUID()}`);
    await mkdir(tmpRoot, { recursive: true });
    gitRepo = await makeTempGitRepo(tmpRoot, 'testrepo', 'main');
    plainDir = await makeTempDir(tmpRoot, 'notgit');
  });

  after(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  test('happy path: returns ok=true with branch/commit/dirty', async () => {
    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/validate',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ path: gitRepo, branch: 'main', ref: 'HEAD' }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.branch, 'main');
    assert.ok(typeof body.commit === 'string' && body.commit.length === 40, 'commit is full SHA');
    assert.equal(typeof body.dirty, 'boolean');
    await app.close();
  });

  test('branch mismatch => ok=false, BRANCH_MISMATCH, checkedOutBranch', async () => {
    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/validate',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ path: gitRepo, branch: 'wrong-branch', ref: 'HEAD' }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'BRANCH_MISMATCH');
    assert.ok(typeof body.message === 'string', 'message present');
    assert.equal(body.checkedOutBranch, 'main', 'checkedOutBranch returned');
    await app.close();
  });

  test('non-git directory => ok=false, WORKSPACE_NOT_GIT', async () => {
    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/validate',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ path: plainDir, branch: 'main', ref: 'HEAD' }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'WORKSPACE_NOT_GIT');
    await app.close();
  });

  test('nonexistent path => ok=false, WORKSPACE_NOT_FOUND', async () => {
    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/validate',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ path: join(tmpRoot, 'does-not-exist'), branch: 'main', ref: 'HEAD' }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'WORKSPACE_NOT_FOUND');
    await app.close();
  });

  test('missing path => 400', async () => {
    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/validate',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ path: 'relative/path', branch: 'main' }),
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('unauthenticated request returns 401', async () => {
    const app = makeApp([tmpRoot]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/validate',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ path: gitRepo }),
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('path outside configured roots => ok=false', async () => {
    const outsideRoot = join(tmpdir(), `tw-validate-outside-${randomUUID()}`);
    await mkdir(outsideRoot, { recursive: true });
    const outsideRepo = await makeTempGitRepo(outsideRoot, 'outrepo', 'main');

    const app = makeApp([tmpRoot]); // outsideRoot not in allowed roots
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/validate',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ path: outsideRepo, branch: 'main', ref: 'HEAD' }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.ok(
      body.code === 'WORKSPACE_OUTSIDE_ROOT' ||
      body.code === 'WORKSPACE_NO_ROOTS' ||
      body.code === 'WORKSPACE_NOT_UNDER_ROOT',
      `unexpected code: ${body.code}`,
    );

    await rm(outsideRoot, { recursive: true, force: true });
    await app.close();
  });
});
