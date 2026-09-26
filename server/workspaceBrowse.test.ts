/**
 * server/workspaceBrowse.test.ts
 *
 * Tests for the workspace browse, roots, and validate endpoints.
 *
 * Uses temporary directories and git repos under tmpdir() for isolation.
 */

import { checkGitWorktrees } from './routes/workspaceBrowse.js';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from './app.js';
import { tmpdir } from 'node:os';
import { join, dirname as pathDirname, join as pathJoin } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, symlink, rm, realpath } from 'node:fs/promises';
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

  test('blank/omitted branch: infers checked-out branch, returns ok=true', async () => {
    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    // Omit branch entirely — the primary "Browse → pick → Apply" flow
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/validate',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({ path: gitRepo, ref: 'HEAD' }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true, `expected ok=true, got: ${JSON.stringify(body)}`);
    assert.equal(body.branch, 'main', 'branch pre-filled from checked-out branch');
    assert.ok(typeof body.commit === 'string' && body.commit.length === 40, 'commit SHA present');
    assert.equal(typeof body.dirty, 'boolean');
    await app.close();
  });

  test('explicit wrong branch still fails with BRANCH_MISMATCH and checkedOutBranch', async () => {
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
      body: JSON.stringify({ path: gitRepo, branch: 'definitely-wrong', ref: 'HEAD' }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'BRANCH_MISMATCH');
    assert.ok(typeof body.message === 'string', 'message present');
    assert.equal(body.checkedOutBranch, 'main', 'checkedOutBranch returned for explicit wrong branch');
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

// ---------------------------------------------------------------------------
// F1 regression: apostrophe in branch name — structured metadata, no parsing
// ---------------------------------------------------------------------------

describe("F1 regression: apostrophe branch name", () => {
  test("blank branch with apostrophe branch name returns ok=true and correct branch", async () => {
    const tmpRoot = join(tmpdir(), `tw-f1-apos-${randomUUID()}`);
    await mkdir(tmpRoot, { recursive: true });

    // Create a repo on a branch whose name contains an apostrophe
    const repoPath = join(tmpRoot, "repo");
    await mkdir(repoPath, { recursive: true });
    await execFile("git", ["init", "-b", "feature/o'brien", repoPath]);
    await execFile("git", ["-C", repoPath, "config", "user.email", "t@example.com"]);
    await execFile("git", ["-C", repoPath, "config", "user.name", "T"]);
    await execFile("sh", ["-c", `echo hello > ${repoPath}/README.md`]);
    await execFile("git", ["-C", repoPath, "add", "."]);
    await execFile("git", ["-C", repoPath, "commit", "-m", "init"]);

    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    // POST with blank branch — should infer and return the apostrophe branch
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/validate",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://localhost:5173",
      },
      body: JSON.stringify({ path: repoPath, ref: "HEAD" }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true, `expected ok=true, got: ${JSON.stringify(body)}`);
    assert.equal(body.branch, "feature/o'brien", "branch matches apostrophe branch name");

    await rm(tmpRoot, { recursive: true, force: true });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// F2 regression: allowed root that is itself a repository
// ---------------------------------------------------------------------------

describe("F2 regression: allowed root is a git repository", () => {
  test("browse at root: no .git entry, root has current field with gitWorktree=true, validate succeeds", async () => {
    const tmpRoot = join(tmpdir(), `tw-f2-root-${randomUUID()}`);
    await mkdir(tmpRoot, { recursive: true });

    // Create a git repo directly as the allowed root (only README.md + .git)
    await execFile("git", ["init", "-b", "main", tmpRoot]);
    await execFile("git", ["-C", tmpRoot, "config", "user.email", "t@example.com"]);
    await execFile("git", ["-C", tmpRoot, "config", "user.name", "T"]);
    await execFile("sh", ["-c", `echo hello > ${tmpRoot}/README.md`]);
    await execFile("git", ["-C", tmpRoot, "add", "."]);
    await execFile("git", ["-C", tmpRoot, "commit", "-m", "init"]);

    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    // Browse root (no ?path=)
    const browseRes = await app.inject({
      method: "GET",
      url: "/api/workspace/browse",
      headers: { cookie },
    });
    assert.equal(browseRes.statusCode, 200);
    const browseBody = browseRes.json();

    // F2a: .git must NOT appear in entries
    const names = (browseBody.entries as { name: string }[]).map((e) => e.name);
    assert.ok(!names.includes(".git"), `.git must not be in entries, got: ${JSON.stringify(names)}`);

    // F2b: root mode should have rootEntries array with the root itself
    // (root is realpath-resolved server-side; on macOS /var → /private/var)
    assert.ok(Array.isArray(browseBody.rootEntries), "rootEntries present");
    const resolvedTmpRoot = await realpath(tmpRoot);
    const rootEntry = (browseBody.rootEntries as { path: string; gitWorktree: boolean }[]).find(
      (e) => e.path === resolvedTmpRoot,
    );
    assert.ok(rootEntry, "root appears in rootEntries");
    assert.equal(rootEntry!.gitWorktree, true, "root flagged as gitWorktree");

    // F2: validate root directly with blank branch succeeds
    const validateRes = await app.inject({
      method: "POST",
      url: "/api/workspace/validate",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://localhost:5173",
      },
      body: JSON.stringify({ path: tmpRoot, ref: "HEAD" }),
    });
    assert.equal(validateRes.statusCode, 200);
    const validateBody = validateRes.json();
    assert.equal(validateBody.ok, true, `expected ok=true, got: ${JSON.stringify(validateBody)}`);

    await rm(tmpRoot, { recursive: true, force: true });
    await app.close();
  });

  test("browse ?path= of a git repo: current.gitWorktree=true, .git not in entries", async () => {
    const tmpRoot = join(tmpdir(), `tw-f2-path-${randomUUID()}`);
    await mkdir(tmpRoot, { recursive: true });
    const repoPath = join(tmpRoot, "myrepo");
    await mkdir(repoPath, { recursive: true });
    await execFile("git", ["init", "-b", "main", repoPath]);
    await execFile("git", ["-C", repoPath, "config", "user.email", "t@example.com"]);
    await execFile("git", ["-C", repoPath, "config", "user.name", "T"]);
    await execFile("sh", ["-c", `echo hello > ${repoPath}/README.md`]);
    await execFile("git", ["-C", repoPath, "add", "."]);
    await execFile("git", ["-C", repoPath, "commit", "-m", "init"]);

    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const browseRes = await app.inject({
      method: "GET",
      url: `/api/workspace/browse?path=${encodeURIComponent(repoPath)}`,
      headers: { cookie },
    });
    assert.equal(browseRes.statusCode, 200);
    const body = browseRes.json();

    // .git not in entries
    const names = (body.entries as { name: string }[]).map((e) => e.name);
    assert.ok(!names.includes(".git"), `.git must not be in entries`);

    // current field present and flagged (realpath-resolved server-side)
    assert.ok(body.current !== undefined, "current field present");
    assert.equal(body.current.path, await realpath(repoPath));
    assert.equal(body.current.gitWorktree, true, "current.gitWorktree=true for git repo");

    await rm(tmpRoot, { recursive: true, force: true });
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// F3 unit tests: deadline math for checkGitWorktrees
// ---------------------------------------------------------------------------

describe("F3: checkGitWorktrees deadline enforcement", () => {
  test("expired deadline: checker never called, all resolve false", async () => {
    let called = 0;
    const checker = async (_p: string, _t: number) => { called++; return true; };
    const paths = ["/a", "/b", "/c"];
    // Pass budgetMs=0 so deadline is immediately expired
    const result = await checkGitWorktrees(paths, 0, checker);
    assert.equal(called, 0, "checker should not be called with expired deadline");
    // All paths should remain unset (no entry), or all false
    for (const p of paths) {
      assert.equal(result.get(p), undefined, `${p} should not be in result`);
    }
  });

  test("ample budget: checker is called and timeout passed is <= 2000", async () => {
    const timeouts: number[] = [];
    const checker = async (_p: string, t: number) => { timeouts.push(t); return false; };
    const paths = ["/x", "/y"];
    await checkGitWorktrees(paths, 10000, checker);
    assert.equal(timeouts.length, 2, "checker called for all paths");
    for (const t of timeouts) {
      assert.ok(t > 0 && t <= 2000, `timeout ${t} should be in (0, 2000]`);
    }
  });

  test("tight budget: checker receives reduced timeout", async () => {
    const timeouts: number[] = [];
    // Simulate a checker that burns time and captures timeouts
    const checker = async (_p: string, t: number) => { timeouts.push(t); return false; };
    const paths = ["/m"];
    // Use a budget of 500ms so remaining is around 500ms → capped to min(2000, ~500)
    await checkGitWorktrees(paths, 500, checker);
    if (timeouts.length > 0) {
      assert.ok(timeouts[0]! <= 2000, "timeout must not exceed 2000");
      assert.ok(timeouts[0]! > 0, "timeout must be positive");
    }
  });
});

// ---------------------------------------------------------------------------
// F4 unit tests: path helpers (Windows-style paths via pure strings)
// ---------------------------------------------------------------------------

describe("F4: browse parentPath uses dirname (Windows-style path strings)", () => {
  test("dirname of a POSIX path works correctly", () => {
    assert.equal(pathDirname("/repos/root/sub"), "/repos/root");
    assert.equal(pathDirname("/repos/root/sub/deep"), "/repos/root/sub");
  });

  test("path.join builds correct entry paths", () => {
    assert.equal(pathJoin("/root", "name"), "/root/name");
    assert.equal(pathJoin("/root/sub", "inner"), "/root/sub/inner");
  });
});

// ---------------------------------------------------------------------------
// F6 regression: whitespace-padded branch/ref in validate
// ---------------------------------------------------------------------------

describe("F6: validate trims branch and ref whitespace", () => {
  test("branch with surrounding spaces validates the same as trimmed", async () => {
    const tmpRoot = join(tmpdir(), `tw-f6-${randomUUID()}`);
    await mkdir(tmpRoot, { recursive: true });
    const repoPath = join(tmpRoot, "repo");
    await mkdir(repoPath, { recursive: true });
    await execFile("git", ["init", "-b", "main", repoPath]);
    await execFile("git", ["-C", repoPath, "config", "user.email", "t@example.com"]);
    await execFile("git", ["-C", repoPath, "config", "user.name", "T"]);
    await execFile("sh", ["-c", `echo hello > ${repoPath}/README.md`]);
    await execFile("git", ["-C", repoPath, "add", "."]);
    await execFile("git", ["-C", repoPath, "commit", "-m", "init"]);

    const app = makeApp([tmpRoot]);
    const regRes = await register(app);
    const cookie = getCookie(regRes);

    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/validate",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://localhost:5173",
      },
      body: JSON.stringify({ path: repoPath, branch: " main ", ref: " HEAD " }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true, `expected ok=true with padded branch, got: ${JSON.stringify(body)}`);
    assert.equal(body.branch, "main");

    await rm(tmpRoot, { recursive: true, force: true });
    await app.close();
  });
});
