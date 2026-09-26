/**
 * server/workspace.ts
 *
 * Git workspace helper for TeamWeave.
 *
 * Responsibilities:
 *  - Resolve and validate a WorkspaceBinding against allowed roots.
 *  - Capture a WorkspaceSnapshot (commit SHA, dirty state, tracked diff, untracked hashes).
 *  - Serialize execution per CANONICAL Git worktree root (cross-org, same process).
 *  - Export runWithWorkspace() for use by the executor.
 *
 * Security rules:
 *  - All paths resolved via realpath; symlinks outside the authorised worktree are rejected.
 *  - Git commands use execFile argument arrays — never shell interpolation.
 *  - NEVER checkout / reset / clean / create branches or worktrees.
 *  - Option-like branch/ref names (starting with '-') are rejected.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, join, dirname } from 'node:path';
import type { WorkspaceBinding, WorkspaceSnapshot } from '../src/types.js';

const execFile = promisify(_execFile);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Maximum size of the binary diff capture (bytes) */
export const MAX_DIFF_BYTES = 10 * 1024 * 1024; // 10 MB

/** Maximum number of untracked files to hash */
export const MAX_UNTRACKED_FILES = 500;

/** Maximum size of a single untracked file to hash (bytes) */
export const MAX_UNTRACKED_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

/** Maximum total captured bytes across all untracked files */
export const MAX_UNTRACKED_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB

// ---------------------------------------------------------------------------
// Per-worktree mutex
// ---------------------------------------------------------------------------

/** Keyed by canonical Git worktree root; separate worktrees run concurrently. */
const worktreeLocks = new Map<string, Promise<void>>();

function acquireLock(worktreeRoot: string): { release: () => void; wait: Promise<void> } {
  // Create the releaser synchronously so it's always defined when we return.
  let release!: () => void;
  const releaser = new Promise<void>((res) => { release = res; });
  const prev = worktreeLocks.get(worktreeRoot) ?? Promise.resolve();
  // The new tail chains: wait for prev, then hold the releaser promise.
  const next = prev.then(() => releaser);
  // Only write the tail back if this entry is still the current tail; prevents
  // leaking resolved entries when lock is uncontested.
  worktreeLocks.set(worktreeRoot, next);
  next.then(() => {
    // After this lock is released, prune the map entry if still our tail.
    if (worktreeLocks.get(worktreeRoot) === next) worktreeLocks.delete(worktreeRoot);
  });
  return { release, wait: prev };
}

// ---------------------------------------------------------------------------
// Git helpers (argument arrays only)
// ---------------------------------------------------------------------------

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, maxBuffer: MAX_DIFF_BYTES + 1024 });
  return stdout.trim();
}

async function gitBinary(cwd: string, ...args: string[]): Promise<Buffer> {
  const { stdout } = await execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: MAX_DIFF_BYTES + 1024 });
  return stdout as unknown as Buffer;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function rejectOptionLike(value: string, field: string): void {
  if (value.startsWith('-'))
    throw Object.assign(new Error(`${field} must not start with '-' (option-like value rejected)`), { code: 'WORKSPACE_OPTION_LIKE' });
}

export function assertUnderRoot(resolvedPath: string, allowedRoots: string[]): void {
  for (const root of allowedRoots) {
    const rel = relative(root, resolvedPath);
    if (!rel.startsWith('..') && !isAbsolute(rel)) return;
  }
  throw Object.assign(
    new Error(`Path ${resolvedPath} is not under any configured allowed root`),
    { code: 'WORKSPACE_OUTSIDE_ROOT' },
  );
}

function assertSymlinkUnderWorktree(resolvedFilePath: string, worktreeRoot: string): void {
  const rel = relative(worktreeRoot, resolvedFilePath);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw Object.assign(
      new Error(`Untracked file symlink ${resolvedFilePath} escapes worktree ${worktreeRoot}`),
      { code: 'WORKSPACE_SYMLINK_ESCAPE' },
    );
}

// ---------------------------------------------------------------------------
// Snapshot capture
// ---------------------------------------------------------------------------

/**
 * resolveBinding: validate binding, check allowed roots, verify Git state.
 * Returns the resolved canonical workspace path and worktree root.
 */
export async function resolveBinding(
  binding: WorkspaceBinding,
  allowedRoots: string[],
): Promise<{ resolvedPath: string; worktreeRoot: string }> {
  if (!isAbsolute(binding.path))
    throw Object.assign(new Error('workspace.path must be absolute'), { code: 'WORKSPACE_PATH_NOT_ABSOLUTE' });

  rejectOptionLike(binding.branch, 'branch');
  rejectOptionLike(binding.ref, 'ref');

  // Resolve realpath (follows symlinks, checks existence)
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(binding.path);
  } catch {
    throw Object.assign(
      new Error(`Workspace path does not exist: ${binding.path}`),
      { code: 'WORKSPACE_NOT_FOUND' },
    );
  }

  // Must be under an allowed root (uses resolved path)
  if (allowedRoots.length === 0)
    throw Object.assign(new Error('No workspace roots configured'), { code: 'WORKSPACE_NO_ROOTS' });

  // Resolve allowed roots too
  const resolvedRoots: string[] = [];
  for (const r of allowedRoots) {
    try { resolvedRoots.push(await realpath(r)); } catch { /* skip unresolvable roots */ }
  }
  assertUnderRoot(resolvedPath, resolvedRoots);

  // Find Git worktree root
  let worktreeRoot: string;
  try {
    worktreeRoot = await git(resolvedPath, 'rev-parse', '--show-toplevel');
  } catch {
    throw Object.assign(
      new Error(`${binding.path} is not inside a Git working tree`),
      { code: 'WORKSPACE_NOT_GIT' },
    );
  }

  // Canonicalize worktree root and authorize it under the allowed roots too.
  // This ensures an allowed subfolder (e.g. /repo/allowed) does NOT authorize
  // the parent Git root (/repo) unless /repo itself is in the allowed list.
  let resolvedWorktreeRoot: string;
  try {
    resolvedWorktreeRoot = await realpath(worktreeRoot);
  } catch {
    throw Object.assign(
      new Error(`Git worktree root does not exist: ${worktreeRoot}`),
      { code: 'WORKSPACE_NOT_FOUND' },
    );
  }
  assertUnderRoot(resolvedWorktreeRoot, resolvedRoots);

  // Verify current branch
  let currentBranch: string;
  try {
    currentBranch = await git(resolvedWorktreeRoot, 'rev-parse', '--abbrev-ref', 'HEAD');
  } catch {
    throw Object.assign(new Error('Unable to determine current Git branch'), { code: 'WORKSPACE_GIT_ERROR' });
  }
  if (currentBranch === 'HEAD')
    throw Object.assign(new Error('Repository is in detached HEAD state'), { code: 'WORKSPACE_DETACHED' });
  if (currentBranch !== binding.branch)
    throw Object.assign(
      new Error(`Branch mismatch: requested '${binding.branch}', current is '${currentBranch}'`),
      { code: 'WORKSPACE_BRANCH_MISMATCH', currentBranch },
    );

  // Resolve requested ref to a commit SHA; use ^{commit} to dereference annotated tags.
  let refSha: string;
  try {
    refSha = await git(resolvedWorktreeRoot, 'rev-parse', '--verify', '--end-of-options', `${binding.ref}^{commit}`);
  } catch {
    throw Object.assign(
      new Error(`Ref '${binding.ref}' could not be resolved in this repository`),
      { code: 'WORKSPACE_UNKNOWN_REF' },
    );
  }

  // Resolve current HEAD SHA
  const headSha = await git(resolvedWorktreeRoot, 'rev-parse', 'HEAD');

  if (refSha !== headSha)
    throw Object.assign(
      new Error(`Ref '${binding.ref}' resolves to ${refSha} but HEAD is ${headSha}`),
      { code: 'WORKSPACE_REF_MISMATCH' },
    );

  return { resolvedPath, worktreeRoot: resolvedWorktreeRoot };
}

/**
 * captureSnapshot: gather Git state for a workspace binding.
 * Must be called while the worktree lock is held.
 */
export async function captureSnapshot(
  binding: WorkspaceBinding,
  allowedRoots: string[],
): Promise<WorkspaceSnapshot> {
  const { resolvedPath, worktreeRoot } = await resolveBinding(binding, allowedRoots);

  const commitSha = await git(worktreeRoot, 'rev-parse', 'HEAD');
  const currentBranch = await git(worktreeRoot, 'rev-parse', '--abbrev-ref', 'HEAD');

  // Dirty check (index + working tree)
  const statusOut = await git(worktreeRoot, 'status', '--porcelain');
  const dirty = statusOut.length > 0;

  // Binary diff (git diff HEAD --binary)
  let trackedDiffBuf: Buffer;
  try {
    trackedDiffBuf = await gitBinary(worktreeRoot, 'diff', 'HEAD', '--binary');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // maxBuffer exceeded means the diff is too large
    if (msg.includes('maxBuffer')) {
      throw Object.assign(
        new Error(`Tracked diff exceeds size cap (${MAX_DIFF_BYTES} bytes)`),
        { code: 'WORKSPACE_DIFF_TOO_LARGE' },
      );
    }
    throw e;
  }
  if (trackedDiffBuf.length > MAX_DIFF_BYTES)
    throw Object.assign(
      new Error(`Tracked diff exceeds size cap (${MAX_DIFF_BYTES} bytes)`),
      { code: 'WORKSPACE_DIFF_TOO_LARGE' },
    );
  const trackedDiff = trackedDiffBuf.toString('base64');

  // Untracked non-ignored files; use -z so NUL-terminated names handle Cyrillic/newlines
  const untrackedBuf = await gitBinary(
    worktreeRoot,
    'ls-files',
    '--others',
    '--exclude-standard',
    '--full-name',
    '-z',
  );

  // Split on NUL; drop trailing empty entry from final NUL
  const untrackedPaths = untrackedBuf.length > 0
    ? untrackedBuf.toString('utf8').split('\0').filter((s) => s.length > 0)
    : [];

  if (untrackedPaths.length > MAX_UNTRACKED_FILES)
    throw Object.assign(
      new Error(`Too many untracked files (${untrackedPaths.length} > ${MAX_UNTRACKED_FILES})`),
      { code: 'WORKSPACE_TOO_MANY_UNTRACKED' },
    );

  const untracked: { path: string; sha256: string }[] = [];
  const fingerprintHasher = createHash('sha256');
  fingerprintHasher.update(commitSha);
  fingerprintHasher.update(dirty ? '1' : '0');
  fingerprintHasher.update(trackedDiffBuf);

  let totalUntrackedBytes = 0;

  for (const relPath of untrackedPaths) {
    const absPath = join(worktreeRoot, relPath);

    // Verify no symlink escape; fail explicitly if the file cannot be accessed
    let resolvedFilePath: string;
    try {
      resolvedFilePath = await realpath(absPath);
    } catch (e: unknown) {
      throw Object.assign(
        new Error(`Untracked file '${relPath}' listed by Git cannot be accessed: ${e instanceof Error ? e.message : String(e)}`),
        { code: 'WORKSPACE_UNTRACKED_INACCESSIBLE' },
      );
    }
    try {
      assertSymlinkUnderWorktree(resolvedFilePath, worktreeRoot);
    } catch {
      throw Object.assign(
        new Error(`Untracked file '${relPath}' is a symlink pointing outside the worktree`),
        { code: 'WORKSPACE_SYMLINK_ESCAPE' },
      );
    }

    let content: Buffer;
    try {
      content = await readFile(resolvedFilePath);
    } catch (e: unknown) {
      throw Object.assign(
        new Error(`Untracked file '${relPath}' listed by Git could not be read: ${e instanceof Error ? e.message : String(e)}`),
        { code: 'WORKSPACE_UNTRACKED_INACCESSIBLE' },
      );
    }
    if (content.length > MAX_UNTRACKED_FILE_BYTES)
      throw Object.assign(
        new Error(`Untracked file '${relPath}' exceeds size cap (${MAX_UNTRACKED_FILE_BYTES} bytes)`),
        { code: 'WORKSPACE_FILE_TOO_LARGE' },
      );

    totalUntrackedBytes += content.length;
    if (totalUntrackedBytes > MAX_UNTRACKED_TOTAL_BYTES)
      throw Object.assign(
        new Error(`Total untracked file bytes exceed cap (${MAX_UNTRACKED_TOTAL_BYTES} bytes)`),
        { code: 'WORKSPACE_UNTRACKED_TOO_LARGE' },
      );

    const sha256 = createHash('sha256').update(content).digest('hex');
    untracked.push({ path: relPath, sha256 });
    fingerprintHasher.update(relPath);
    fingerprintHasher.update(sha256);
  }

  const fingerprint = fingerprintHasher.digest('hex');

  return {
    path: resolvedPath,
    repositoryPath: worktreeRoot,
    branch: currentBranch,
    requestedRef: binding.ref,
    commitSha,
    dirty,
    fingerprint,
    trackedDiff,
    untracked,
  };
}

// ---------------------------------------------------------------------------
// Public API: runWithWorkspace
// ---------------------------------------------------------------------------

/**
 * runWithWorkspace — acquires the per-worktree lock, captures pre/post snapshots,
 * and invokes fn() with the pre-snapshot while holding the lock.
 *
 * A queued job that has been cancelled (signal aborted) before the lock is
 * acquired will never call fn().
 *
 * The lock is always released, even on error.
 *
 * @returns { before, after, result } where after is captured even on fn() failure.
 */
export async function runWithWorkspace<T>(
  binding: WorkspaceBinding,
  allowedRoots: string[],
  signal: AbortSignal,
  fn: (snapshot: WorkspaceSnapshot) => Promise<T>,
): Promise<{ before: WorkspaceSnapshot; after: WorkspaceSnapshot | null; result: T }> {
  // We need the worktree root to key the lock, so resolve binding first (outside lock)
  const { worktreeRoot } = await resolveBinding(binding, allowedRoots);

  const { release, wait } = acquireLock(worktreeRoot);

  // Wait for the lock
  await wait;

  // If cancelled while waiting, abort before spawning anything
  if (signal.aborted) {
    release();
    throw Object.assign(new Error('Workspace job cancelled before execution'), { code: 'WORKSPACE_CANCELLED' });
  }

  let before: WorkspaceSnapshot;
  try {
    before = await captureSnapshot(binding, allowedRoots);
  } catch (err) {
    release();
    throw err;
  }

  let result: T;
  let fnError: unknown = null;
  try {
    result = await fn(before);
  } catch (err) {
    fnError = err;
    result = undefined as unknown as T; // will throw below
  }

  // Capture post-snapshot even on failure (best effort)
  let after: WorkspaceSnapshot | null = null;
  try {
    after = await captureSnapshot(binding, allowedRoots);
  } catch {
    // Post-snapshot failure is non-fatal
  }

  release();

  if (fnError !== null) throw fnError;

  return { before, after, result };
}
