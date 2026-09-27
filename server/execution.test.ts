/**
 * server/execution.test.ts
 *
 * Focused tests for executor.ts + workspace.ts.
 * Uses local Git fixtures and fake shell executables only — no real Bob/providers.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  executeTask,
  assemblePrompt,
  DEFAULT_MAX_COST,
  DEFAULT_MAX_TURNS,
  type ExecuteTaskInput,
} from './executor.js';
import { resolveBinding, captureSnapshot, runWithWorkspace, sameWorkspaceContent } from './workspace.js';
import type { WorkerNode, GraphContext, WorkspaceBinding } from '../src/types.js';

const execFile = promisify(_execFile);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Shared temp dir for entire suite; each test gets a sub-directory. */
let suiteDir: string;
before(async () => { suiteDir = await mkdtemp(join(tmpdir(), 'tw-exec-')); });
after(async () => { await rm(suiteDir, { recursive: true, force: true }); });

/** Create a minimal Git repo initialised at a named branch with one commit. */
async function makeRepo(name: string, branch = 'main'): Promise<string> {
  const dir = join(suiteDir, name);
  await mkdir(dir, { recursive: true });
  await execFile('git', ['-C', dir, 'init', '-b', branch]);
  await execFile('git', ['-C', dir, 'config', 'user.email', 'test@test.local']);
  await execFile('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await writeFile(join(dir, 'README.md'), '# test\n');
  await execFile('git', ['-C', dir, 'add', '.']);
  await execFile('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

/** Return current HEAD SHA for a repo. */
async function headSha(dir: string): Promise<string> {
  const { stdout } = await execFile('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

/** Minimal WorkerNode using 'bob' provider. */
function makeNode(override: Partial<WorkerNode> = {}): WorkerNode {
  return {
    id: 'n1',
    graphId: 'g1',
    teamId: 't1',
    type: 'worker',
    name: 'Test task',
    status: 'queued',
    priority: 'normal',
    progress: 0,
    prompt: { task: 'Do the thing', refinements: [], comments: [] },
    executor: { provider: 'bob', model: 'claude-3-5', skills: [], tools: [], maxIterations: DEFAULT_MAX_TURNS },
    context: { files: [], extra: '' },
    owners: { author: 'alice', responsible: [] },
    inputs: [],
    output: { summary: '', results: [], commands: [], artifacts: [] },
    history: [],
    version: 1,
    position: { x: 0, y: 0 },
    ...override,
  };
}

function makeGraph(workspaceOverride?: WorkspaceBinding): GraphContext {
  return { id: 'g1', teamId: 't1', goal: 'Goal', repo: 'org/repo', conventions: '', workspace: workspaceOverride };
}

/** Write a fake bob script that writes stdout JSON and optional file. */
async function makeFakeScript(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o755 });
}

/** Build ExecuteTaskInput for bob with a fake binary. */
function makeInput(
  node: WorkerNode,
  graph: GraphContext,
  bobBin: string,
  allowedRoots: string[],
  extra: Partial<ExecuteTaskInput> = {},
): ExecuteTaskInput {
  const ac = new AbortController();
  return {
    node,
    graph,
    incoming: [],
    assembledPrompt: assemblePrompt(node, graph, [], null),
    signal: ac.signal,
    bobBin,
    allowedRoots,
    timeoutMs: 5000,
    injectedApiKey: 'fake-test-key-do-not-use',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------
describe('mock provider', () => {
  test('returns done/simulated without workspace or bob binary', async () => {
    const node = makeNode({ executor: { provider: 'mock', model: 'm', skills: [], tools: [], maxIterations: 5 } });
    const graph = makeGraph();
    const ac = new AbortController();
    const r = await executeTask({
      node, graph, incoming: [], assembledPrompt: 'x', signal: ac.signal,
    });
    assert.equal(r.status, 'done');
    assert.equal(r.simulated, true);
    assert.equal(r.workspaceBefore, null);
  });
});

// ---------------------------------------------------------------------------
// Unsupported provider / output mode
// ---------------------------------------------------------------------------
describe('unsupported provider and output', () => {
  test('unknown provider fails without spawn', async () => {
    const node = makeNode({ executor: { provider: 'openai' as never, model: 'm', skills: [], tools: [], maxIterations: 5 } });
    const graph = makeGraph();
    const ac = new AbortController();
    const r = await executeTask({ node, graph, incoming: [], assembledPrompt: 'x', signal: ac.signal });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /not supported/i);
    assert.equal(r.workspaceBefore, null);
  });

  test('commit output mode fails before spawn', async () => {
    const node = makeNode({ desiredOutput: 'commit' });
    const graph = makeGraph();
    const ac = new AbortController();
    const r = await executeTask({ node, graph, incoming: [], assembledPrompt: 'x', signal: ac.signal });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /not supported/i);
  });

  test('pull_request output mode fails before spawn', async () => {
    const node = makeNode({ desiredOutput: 'pull_request' });
    const graph = makeGraph();
    const ac = new AbortController();
    const r = await executeTask({ node, graph, incoming: [], assembledPrompt: 'x', signal: ac.signal });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /not supported/i);
  });
});

// ---------------------------------------------------------------------------
// Bob provider: fake script success (writes persistent file, no TASK.md)
// ---------------------------------------------------------------------------
describe('bob provider: fake script', { timeout: 15000 }, () => {
  let repoDir: string;
  let bobBin: string;
  let persistFile: string;

  before(async () => {
    repoDir = await makeRepo(`bob-success-${randomUUID().slice(0, 8)}`);
    persistFile = join(repoDir, 'OUTPUT.txt');
    bobBin = join(suiteDir, `fake-bob-success-${randomUUID().slice(0, 8)}.sh`);
    // Write OUTPUT.txt in cwd (which is the workspace path) and emit success JSON
    await makeFakeScript(bobBin, `#!/bin/sh
# Read and discard stdin
cat > /dev/null
# Write output file in cwd (workspace path)
echo "bob wrote this" > ./OUTPUT.txt
echo '{"type":"result","status":"success","last_message":"all done","stats":{"task_id":"T99","session_costs":1.23}}'
`);
  });

  test('success: writes file, returns done with taskId/sessionCosts', async () => {
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const node = makeNode({ workspace: binding });
    const graph = makeGraph();
    const ac = new AbortController();

    const r = await executeTask({
      node, graph, incoming: [], assembledPrompt: 'do thing', signal: ac.signal,
      bobBin, allowedRoots: [repoDir], timeoutMs: 8000, injectedApiKey: 'fake-test-key-do-not-use',
    });

    assert.equal(r.status, 'done', `error: ${(r as { error?: string }).error}`);
    assert.equal(r.simulated, false);
    assert.equal(r.taskId, 'T99');
    assert.equal(r.sessionCosts, 1.23);
    assert.ok(r.workspaceBefore !== null);
    // Persistent file written by fake bob in its cwd (the workspace path)
    const written = await readFile(persistFile, 'utf8');
    assert.match(written, /bob wrote this/);
    // TASK.md must not exist in the workspace
    await assert.rejects(
      () => readFile(join(repoDir, 'TASK.md'), 'utf8'),
      (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
    );
  });

  test('stdin contains assembled prompt', async () => {
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const node = makeNode({ workspace: binding });
    const captureFile = join(suiteDir, `stdin-cap-${randomUUID().slice(0, 8)}.txt`);
    const capBin = join(suiteDir, `cap-bob-${randomUUID().slice(0, 8)}.sh`);
    await makeFakeScript(capBin, `#!/bin/sh\ncat > "${captureFile}"\necho '{"type":"result","status":"success","last_message":"ok","stats":{}}'\n`);

    const prompt = assemblePrompt(node, makeGraph(), [], null);
    const ac = new AbortController();
    await executeTask({
      node, graph: makeGraph(), incoming: [], assembledPrompt: prompt, signal: ac.signal,
      bobBin: capBin, allowedRoots: [repoDir], timeoutMs: 8000, injectedApiKey: 'fake-test-key-do-not-use',
    });
    const captured = await readFile(captureFile, 'utf8');
    assert.ok(captured.includes('TeamWeave Task'), 'stdin should contain assembled prompt');
  });

  test('bob args include --max-cost and --max-turns', async () => {
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const node = makeNode({ workspace: binding, executor: { provider: 'bob', model: 'm', skills: [], tools: [], maxIterations: 3, maxCost: 0.25 } });
    const argsFile = join(suiteDir, `args-cap-${randomUUID().slice(0, 8)}.txt`);
    const argsBin = join(suiteDir, `args-bob-${randomUUID().slice(0, 8)}.sh`);
    await makeFakeScript(argsBin, `#!/bin/sh\ncat > /dev/null\necho "$@" > "${argsFile}"\necho '{"type":"result","status":"success","last_message":"ok","stats":{}}'\n`);

    const ac = new AbortController();
    await executeTask({
      node, graph: makeGraph(), incoming: [], assembledPrompt: 'p', signal: ac.signal,
      bobBin: argsBin, allowedRoots: [repoDir], timeoutMs: 8000, injectedApiKey: 'fake-test-key-do-not-use',
    });
    const args = await readFile(argsFile, 'utf8');
    assert.ok(args.includes('--max-cost'), 'args should include --max-cost');
    assert.ok(args.includes('--max-turns'), 'args should include --max-turns');
    assert.ok(args.includes('0.25'), 'max-cost value should be 0.25');
    assert.ok(args.includes('3'), 'max-turns value should be 3');
  });
});

// ---------------------------------------------------------------------------
// Bob provider: NDJSON error+success retains 4.040972 costs but fails
// ---------------------------------------------------------------------------
describe('bob provider: NDJSON error event overrides success', { timeout: 10000 }, () => {
  test('error without stats preserves final result costs while failing', async () => {
    const repoDir = await makeRepo(`ndjson-err-${randomUUID().slice(0, 8)}`);
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const node = makeNode({ workspace: binding });
    // Emit both a cost_limit event and a result success — error should win; costs preserved
    const bobBin = join(suiteDir, `ndjson-bob-${randomUUID().slice(0, 8)}.sh`);
    await makeFakeScript(bobBin, `#!/bin/sh
cat > /dev/null
printf '{"type":"error","message":"exceeded"}\\n'
printf '{"type":"result","status":"success","last_message":"ok","stats":{"task_id":"T1","session_costs":4.040972}}\\n'
`);
    const ac = new AbortController();
    const r = await executeTask({
      node, graph: makeGraph(), incoming: [], assembledPrompt: 'p', signal: ac.signal,
      bobBin, allowedRoots: [repoDir], timeoutMs: 8000, injectedApiKey: 'fake-test-key-do-not-use',
    });
    assert.equal(r.status, 'failed');
    assert.equal(r.sessionCosts, 4.040972);
    assert.equal(r.taskId, 'T1');
  });
});

// ---------------------------------------------------------------------------
// Bob provider: missing result / nonzero / timeout / cancel
// ---------------------------------------------------------------------------
describe('bob provider: failure modes', { timeout: 20000 }, () => {
  let repoDir: string;

  before(async () => {
    repoDir = await makeRepo(`failures-${randomUUID().slice(0, 8)}`);
  });

  async function runWith(script: string, extra: Partial<ExecuteTaskInput> = {}): Promise<Awaited<ReturnType<typeof executeTask>>> {
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const node = makeNode({ workspace: binding });
    const bobBin = join(suiteDir, `fail-bob-${randomUUID().slice(0, 8)}.sh`);
    await makeFakeScript(bobBin, script);
    const ac = new AbortController();
    return executeTask({
      node, graph: makeGraph(), incoming: [], assembledPrompt: 'p',
      signal: ac.signal, bobBin, allowedRoots: [repoDir], timeoutMs: 5000,
      injectedApiKey: 'fake-test-key-do-not-use',
      ...extra,
    });
  }

  test('nonzero exit => failed', async () => {
    const r = await runWith('#!/bin/sh\ncat>/dev/null\nexit 1\n');
    assert.equal(r.status, 'failed');
    assert.ok(r.workspaceBefore !== null);
  });

  test('null signal exit (killed by signal) => failed', async () => {
    // Bob exits via signal; exitCode will be null
    const r = await runWith('#!/bin/sh\ncat>/dev/null\necho \'{"type":"result","status":"success","last_message":"ok","stats":{}}\'\nkill -9 $$\n');
    // May not always be signal-killed, but if exit!=0 it should fail regardless
    assert.equal(r.status, 'failed');
  });

  test('missing result event => failed', async () => {
    const r = await runWith('#!/bin/sh\ncat>/dev/null\necho "not json"\n');
    assert.equal(r.status, 'failed');
    assert.match(r.error, /without a result event/i);
  });

  test('result status error => failed', async () => {
    const r = await runWith('#!/bin/sh\ncat>/dev/null\necho \'{"type":"result","status":"error","last_message":"oops","stats":{}}\'\n');
    assert.equal(r.status, 'failed');
  });

  test('timeout => failed with timed out message', { timeout: 15000 }, async () => {
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const node = makeNode({ workspace: binding });
    const bobBin = join(suiteDir, `timeout-bob-${randomUUID().slice(0, 8)}.sh`);
    // Sleep longer than timeout; use short timeout
    await makeFakeScript(bobBin, '#!/bin/sh\ncat>/dev/null\nsleep 60\n');
    const ac = new AbortController();
    const r = await executeTask({
      node, graph: makeGraph(), incoming: [], assembledPrompt: 'p',
      signal: ac.signal, bobBin, allowedRoots: [repoDir], timeoutMs: 300,
      injectedApiKey: 'fake-test-key-do-not-use',
    });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /timed out/i);
    assert.ok(r.workspaceBefore !== null);
  });

  test('cancel => failed with cancelled message', { timeout: 15000 }, async () => {
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const node = makeNode({ workspace: binding });
    const bobBin = join(suiteDir, `cancel-bob-${randomUUID().slice(0, 8)}.sh`);
    await makeFakeScript(bobBin, '#!/bin/sh\ncat>/dev/null\nsleep 60\n');
    const ac = new AbortController();
    let prepared!: () => void;
    const preparedBarrier = new Promise<void>(resolve => { prepared = resolve; });
    const promise = executeTask({
      node, graph: makeGraph(), incoming: [], assembledPrompt: 'p',
      signal: ac.signal, bobBin, allowedRoots: [repoDir], timeoutMs: 10000,
      injectedApiKey: 'fake-test-key-do-not-use',
      onPrepared: () => prepared(),
    });
    // Cancel only after the snapshot is captured and execution has started.
    await Promise.race([preparedBarrier, promise.then(() => assert.fail('execution ended before preparation'))]);
    ac.abort();
    const r = await promise;
    assert.equal(r.status, 'failed');
    assert.match(r.error, /cancelled/i);
    assert.ok(r.workspaceBefore !== null);
  });

  test('cancel before preparation does not spawn or invent a workspace snapshot', async () => {
    const ac = new AbortController();
    ac.abort();
    let prepared = false;
    const marker = join(suiteDir, `unstarted-${randomUUID()}`);
    const r = await runWith('#!/bin/sh\nprintf started > "$TEST_MARKER"\n', {
      signal: ac.signal,
      injectedEnv: { TEST_MARKER: marker },
      onPrepared: () => { prepared = true; },
    });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /cancelled/i);
    assert.equal(prepared, false);
    assert.equal(r.workspaceBefore, null);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  });

  test('bob not configured (no key) => failed with config message', async () => {
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const node = makeNode({ workspace: binding });
    const bobBin = join(suiteDir, `nokey-bob-${randomUUID().slice(0, 8)}.sh`);
    await makeFakeScript(bobBin, '#!/bin/sh\necho ok\n');
    const ac = new AbortController();
    // Pass injectedApiKey as empty string => no key
    const r = await executeTask({
      node, graph: makeGraph(), incoming: [], assembledPrompt: 'p',
      signal: ac.signal, bobBin, allowedRoots: [repoDir], timeoutMs: 5000,
      injectedApiKey: '',
    });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /not configured/i);
  });
});

// ---------------------------------------------------------------------------
// Workspace: same-worktree queue serializes subdirectories, releases after failure
// ---------------------------------------------------------------------------
describe('workspace queue', { timeout: 20000 }, () => {
  test('same worktree serializes two runs; lock released after fn() failure', async () => {
    const repoDir = await makeRepo(`queue-${randomUUID().slice(0, 8)}`);
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const allowedRoots = [repoDir];

    const order: string[] = [];

    // Barrier: resolves once p1's callback has been entered, guaranteeing p1 holds
    // the lock before p2 is even queued (resolveBinding is async so without the
    // barrier both jobs could race to acquireLock).
    let p1Entered!: () => void;
    const p1EnteredBarrier = new Promise<void>((res) => { p1Entered = res; });

    const p1 = runWithWorkspace(binding, allowedRoots, new AbortController().signal, async (_snap) => {
      p1Entered();
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('a-end');
      return 'A';
    });

    // Wait until p1 is inside its callback (lock held) before queuing p2
    await p1EnteredBarrier;
    const p2 = runWithWorkspace(binding, allowedRoots, new AbortController().signal, async (_snap) => {
      order.push('b-start');
      order.push('b-end');
      return 'B';
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.result, 'A');
    assert.equal(r2.result, 'B');
    // Serialized: a must fully complete before b starts
    assert.ok(order.indexOf('a-end') < order.indexOf('b-start'), `order: ${order.join(',')}`);
  });

  test('lock is released after fn() throws, subsequent run succeeds', async () => {
    const repoDir = await makeRepo(`queue-fail-${randomUUID().slice(0, 8)}`);
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const allowedRoots = [repoDir];

    let p1Entered!: () => void;
    const p1EnteredBarrier = new Promise<void>((res) => { p1Entered = res; });

    const p1 = runWithWorkspace(binding, allowedRoots, new AbortController().signal, async () => {
      p1Entered();
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('fn failure');
    });

    await p1EnteredBarrier;
    const p2 = runWithWorkspace(binding, allowedRoots, new AbortController().signal, async () => 'ok');

    await assert.rejects(p1, /fn failure/);
    const r2 = await p2;
    assert.equal(r2.result, 'ok');
  });

  test('subdirectory binding uses same lock as repo root', async () => {
    const repoDir = await makeRepo(`queue-sub-${randomUUID().slice(0, 8)}`);
    // Create a subdirectory so we can bind to it
    const subDir = join(repoDir, 'sub');
    await mkdir(subDir);
    await writeFile(join(subDir, 'x.txt'), 'x');
    await execFile('git', ['-C', repoDir, 'add', '.']);
    await execFile('git', ['-C', repoDir, 'commit', '-m', 'add sub']);
    const sha = await headSha(repoDir);
    const bindingRoot: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const bindingSub: WorkspaceBinding = { path: subDir, branch: 'main', ref: sha };
    const allowedRoots = [repoDir];

    const order: string[] = [];

    // Barrier: wait until root callback is entered before queuing sub job
    let rootEntered!: () => void;
    const rootEnteredBarrier = new Promise<void>((res) => { rootEntered = res; });

    const p1 = runWithWorkspace(bindingRoot, allowedRoots, new AbortController().signal, async () => {
      rootEntered();
      order.push('root-start');
      await new Promise((r) => setTimeout(r, 60));
      order.push('root-end');
    });

    await rootEnteredBarrier;
    const p2 = runWithWorkspace(bindingSub, allowedRoots, new AbortController().signal, async () => {
      order.push('sub-start');
    });

    await Promise.all([p1, p2]);
    assert.ok(order.indexOf('root-end') < order.indexOf('sub-start'), `order: ${order.join(',')}`);
  });

  test('queued cancelled job skips fn, later job still runs', async () => {
    const repoDir = await makeRepo(`queue-cancel-${randomUUID().slice(0, 8)}`);
    const sha = await headSha(repoDir);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const allowedRoots = [repoDir];

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const ac3 = new AbortController();

    // p1 holds lock for a bit
    let p1Entered!: () => void;
    const p1EnteredBarrier = new Promise<void>((res) => { p1Entered = res; });

    const p1 = runWithWorkspace(binding, allowedRoots, ac1.signal, async () => {
      p1Entered();
      await new Promise((r) => setTimeout(r, 80));
    });

    // Wait until p1 holds the lock before queuing p2/p3
    await p1EnteredBarrier;

    // p2 queued; attach rejection handler immediately before aborting to avoid
    // unhandledRejection if the promise rejects synchronously on the next tick.
    const p2 = runWithWorkspace(binding, allowedRoots, ac2.signal, async () => {
      throw new Error('p2 should not run');
    });
    const p2Rejected = assert.rejects(p2, /cancelled/i);
    ac2.abort(); // cancel while p1 holds lock

    // p3 queued after p2
    let p3Ran = false;
    const p3 = runWithWorkspace(binding, allowedRoots, ac3.signal, async () => {
      p3Ran = true;
    });

    await p1;
    await p2Rejected;
    await p3;
    assert.ok(p3Ran, 'p3 should have run after cancelled p2');
  });
});

// ---------------------------------------------------------------------------
// Workspace: annotated tag and ref mismatch
// ---------------------------------------------------------------------------
describe('resolveBinding: tag handling', () => {
  test('annotated tag pointing at HEAD resolves correctly', async () => {
    const repoDir = await makeRepo(`tag-ann-${randomUUID().slice(0, 8)}`);
    // Create an annotated tag at HEAD
    await execFile('git', ['-C', repoDir, 'tag', '-a', 'v1.0.0', '-m', 'release']);
    const sha = await headSha(repoDir);

    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: 'v1.0.0' };
    const { worktreeRoot, resolvedPath } = await resolveBinding(binding, [repoDir]);
    assert.equal(resolvedPath, await realpath(repoDir));
    assert.ok(worktreeRoot.length > 0);
  });

  test('annotated tag pointing at older commit is rejected (ref mismatch)', async () => {
    const repoDir = await makeRepo(`tag-old-${randomUUID().slice(0, 8)}`);
    // Tag at initial commit
    await execFile('git', ['-C', repoDir, 'tag', '-a', 'v0.1.0', '-m', 'old']);
    // Make a new commit so HEAD advances
    await writeFile(join(repoDir, 'new.txt'), 'new');
    await execFile('git', ['-C', repoDir, 'add', '.']);
    await execFile('git', ['-C', repoDir, 'commit', '-m', 'second']);

    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: 'v0.1.0' };
    await assert.rejects(
      () => resolveBinding(binding, [repoDir]),
      (e: Error) => e.message.includes('HEAD') || (e as { code?: string }).code === 'WORKSPACE_REF_MISMATCH',
    );
  });

  test('lightweight tag at HEAD resolves correctly', async () => {
    const repoDir = await makeRepo(`tag-lw-${randomUUID().slice(0, 8)}`);
    await execFile('git', ['-C', repoDir, 'tag', 'v2.0.0']);

    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: 'v2.0.0' };
    const result = await resolveBinding(binding, [repoDir]);
    assert.ok(result.worktreeRoot.length > 0);
  });

  test('non-existent ref is rejected', async () => {
    const repoDir = await makeRepo(`tag-miss-${randomUUID().slice(0, 8)}`);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: 'v99.99.99' };
    await assert.rejects(
      () => resolveBinding(binding, [repoDir]),
      (e: Error) => (e as { code?: string }).code === 'WORKSPACE_UNKNOWN_REF',
    );
  });
});

// ---------------------------------------------------------------------------
// Workspace: root escape (git root not in allowed roots)
// ---------------------------------------------------------------------------
describe('resolveBinding: root escape', () => {
  test('allowed subfolder does not authorize git root above it', async () => {
    // Create a repo with a subdirectory that is in allowedRoots but the git root is not
    const base = join(suiteDir, `escape-${randomUUID().slice(0, 8)}`);
    const repoDir = join(base, 'repo');
    const allowedSubdir = join(repoDir, 'allowed');
    await mkdir(allowedSubdir, { recursive: true });
    await writeFile(join(allowedSubdir, 'file.txt'), 'x');
    await execFile('git', ['-C', repoDir, 'init', '-b', 'main']);
    await execFile('git', ['-C', repoDir, 'config', 'user.email', 'test@test.local']);
    await execFile('git', ['-C', repoDir, 'config', 'user.name', 'Test']);
    await execFile('git', ['-C', repoDir, 'add', '.']);
    await execFile('git', ['-C', repoDir, 'commit', '-m', 'init']);

    // Only allowedSubdir is in allowedRoots, not repoDir itself
    // resolveBinding should fail because git root (repoDir) is not authorized
    const sha = (await execFile('git', ['-C', repoDir, 'rev-parse', 'HEAD'])).stdout.trim();
    const binding: WorkspaceBinding = { path: allowedSubdir, branch: 'main', ref: sha };

    await assert.rejects(
      () => resolveBinding(binding, [allowedSubdir]),
      (e: Error) => (e as { code?: string }).code === 'WORKSPACE_OUTSIDE_ROOT',
    );
  });
});

// ---------------------------------------------------------------------------
// Workspace: Cyrillic + newline untracked fingerprints
// ---------------------------------------------------------------------------
describe('captureSnapshot: special filenames', { timeout: 10000 }, () => {
  test('Finder metadata does not cause drift but document and tracked metadata changes do', async () => {
    const repoDir = await makeRepo(`finder-${randomUUID().slice(0, 8)}`);
    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: 'HEAD' };
    const before = await captureSnapshot(binding, [repoDir]);
    await writeFile(join(repoDir, '.DS_Store'), 'finder view state');
    const after = await captureSnapshot(binding, [repoDir]);
    assert.equal(after.dirty, true); // Still accurately reports raw Git state.
    assert.equal(before.fingerprint, after.fingerprint);
    assert.equal(sameWorkspaceContent(before, { ...after, fingerprint: 'legacy-fingerprint' }), true);
    await writeFile(join(repoDir, 'notes.md'), 'actual change');
    const changed = await captureSnapshot(binding, [repoDir]);
    assert.equal(sameWorkspaceContent(after, changed), false);
    await writeFile(join(repoDir, '.DS_Store'), 'new view state');
    assert.equal(sameWorkspaceContent(changed, await captureSnapshot(binding, [repoDir])), true);
    await execFile('git', ['-C', repoDir, 'add', '.DS_Store']);
    await execFile('git', ['-C', repoDir, 'commit', '-m', 'Track intentional metadata fixture']);
    const tracked = await captureSnapshot(binding, [repoDir]);
    await writeFile(join(repoDir, '.DS_Store'), 'tracked change');
    assert.equal(sameWorkspaceContent(tracked, await captureSnapshot(binding, [repoDir])), false);
  });

  test('Cyrillic filename included in fingerprint', async () => {
    const repoDir = await makeRepo(`cyrillic-${randomUUID().slice(0, 8)}`);
    const sha = await headSha(repoDir);
    // Add untracked file with Cyrillic name
    const cyrName = 'файл.txt';
    await writeFile(join(repoDir, cyrName), 'content');

    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const snap = await captureSnapshot(binding, [repoDir]);
    assert.ok(snap.untracked.some((u) => u.path === cyrName), `Expected ${cyrName} in untracked; got: ${JSON.stringify(snap.untracked)}`);
    assert.ok(snap.fingerprint.length > 0);
  });

  test('filename with spaces included in fingerprint', async () => {
    const repoDir = await makeRepo(`spaces-${randomUUID().slice(0, 8)}`);
    const sha = await headSha(repoDir);
    const spaceName = 'hello world.txt';
    await writeFile(join(repoDir, spaceName), 'data');

    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    const snap = await captureSnapshot(binding, [repoDir]);
    assert.ok(snap.untracked.some((u) => u.path === spaceName), `Expected '${spaceName}' in untracked; got: ${JSON.stringify(snap.untracked)}`);
  });

  test('symlink escaping worktree is rejected', async () => {
    const repoDir = await makeRepo(`symlink-esc-${randomUUID().slice(0, 8)}`);
    const sha = await headSha(repoDir);
    // Create symlink pointing outside worktree
    const outside = join(suiteDir, `outside-${randomUUID().slice(0, 8)}`);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(repoDir, 'escape.txt'));

    const binding: WorkspaceBinding = { path: repoDir, branch: 'main', ref: sha };
    await assert.rejects(
      () => captureSnapshot(binding, [repoDir]),
      (e: Error) => (e as { code?: string }).code === 'WORKSPACE_SYMLINK_ESCAPE',
    );
  });
});

// Regressions for process shutdown and the runtime handoff contract.
describe('executor integration boundaries', { timeout: 20000 }, () => {
  test('freezes the exact stdin prompt and structured result with caller attempt ID', async () => {
    const repo = await makeRepo(`prepared-${randomUUID()}`);
    const captured = join(suiteDir, `prompt-${randomUUID()}`);
    const bin = join(suiteDir, `prepared-${randomUUID()}.sh`);
    await makeFakeScript(bin, `#!/bin/sh\ncat > "${captured}"\nprintf '%s' '{"type":"result","status":"success","stats":{"task_id":"prepared","session_costs":0.02},"last_message":"{\\"summary\\":\\"ok\\",\\"results\\":[\\"checked\\"],\\"commands\\":[],\\"artifacts\\":[]}"}'\n`);
    const node = makeNode({ workspace: { path: repo, branch: 'main', ref: 'HEAD' } });
    let prepared = '';
    const result = await executeTask(makeInput(node, makeGraph(), bin, [repo], {
      assembledPrompt: 'Frozen prompt sentinel', attemptId: 'attempt-owned-by-runtime',
      onPrepared: value => { prepared = value.assembledPrompt; assert.ok(value.workspaceBefore?.commitSha); },
    }));
    assert.equal(result.status, 'done');
    assert.equal(result.identity.attemptId, 'attempt-owned-by-runtime');
    assert.equal(await readFile(captured, 'utf8'), prepared);
    assert.ok(prepared.startsWith('Frozen prompt sentinel'));
    if (result.status === 'done') assert.deepEqual(result.output.results, ['checked']);
  });

  test('missing binary and prematurely closed stdin produce failed attempts', async () => {
    const repo = await makeRepo(`pipe-${randomUUID()}`);
    const node = makeNode({ workspace: { path: repo, branch: 'main', ref: 'HEAD' } });
    const missing = await executeTask(makeInput(node, makeGraph(), join(suiteDir, 'missing-binary'), [repo]));
    assert.equal(missing.status, 'failed');
    const bin = join(suiteDir, `early-exit-${randomUUID()}.sh`);
    await makeFakeScript(bin, '#!/bin/sh\nexit 1\n');
    const early = await executeTask(makeInput(node, makeGraph(), bin, [repo], { assembledPrompt: 'x'.repeat(2_000_000) }));
    assert.equal(early.status, 'failed');
  });

  test('cancel stops a TERM-ignoring child before another workspace task starts', async () => {
    const repo = await makeRepo(`descendant-${randomUUID()}`);
    const marker = join(repo, 'heartbeat.txt');
    const bin = join(suiteDir, `parent-${randomUUID()}.cjs`);
    const childCode = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),10);`;
    await makeFakeScript(bin, `#!/usr/bin/env node\nconst {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});process.stdin.resume();process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);\n`);
    const binding: WorkspaceBinding = { path: repo, branch: 'main', ref: 'HEAD' };
    const ac = new AbortController();
    const running = executeTask(makeInput(makeNode({ workspace: binding }), makeGraph(), bin, [repo], { signal: ac.signal }));
    try {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        if (await readFile(marker, 'utf8').catch(() => '')) break;
        await new Promise(r => setTimeout(r, 20));
      }
      assert.ok(await readFile(marker, 'utf8'));
      ac.abort();
      assert.equal((await running).status, 'failed');
      await runWithWorkspace(binding, [repo], new AbortController().signal, async () => {
        const stopped = await readFile(marker, 'utf8');
        await new Promise(r => setTimeout(r, 100));
        assert.equal(await readFile(marker, 'utf8'), stopped);
      });
    } finally { ac.abort(); await running; }
  });
});
