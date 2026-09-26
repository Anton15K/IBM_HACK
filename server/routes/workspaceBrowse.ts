/**
 * server/routes/workspaceBrowse.ts
 *
 * Read-only workspace browsing and binding validation endpoints.
 *
 * Endpoints:
 *   GET  /api/workspace/roots     — list configured allowed roots
 *   GET  /api/workspace/browse    — list directories under a root
 *   POST /api/workspace/validate  — validate a workspace binding at set-time
 *
 * Security:
 *   - All paths are confined to configured workspace roots via assertUnderRoot.
 *   - No file contents are ever returned.
 *   - Git commands use execFile argument arrays — no shell interpolation.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, readdir, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { resolveSession } from '../session.js';
import { resolveAllowedRoots } from '../executor.js';
import { assertUnderRoot, resolveBinding } from '../workspace.js';

const execFile = promisify(_execFile);

const BROWSE_CAP = 200;
const GIT_CHECK_CONCURRENCY = 8;
const GIT_CHECK_BUDGET_MS = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve TEAMWEAVE_WORKSPACE_ROOTS to de-duped real paths (silently skips unresolvable) */
async function resolveRoots(injected?: string[]): Promise<string[]> {
  const raw = resolveAllowedRoots(injected);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    try {
      const rp = await realpath(r);
      if (!seen.has(rp)) { seen.add(rp); out.push(rp); }
    } catch { /* skip */ }
  }
  return out;
}

/**
 * Run git command with a capped timeout; returns true if exit 0.
 * @param dirPath directory to check
 * @param timeoutMs max time to spend (clamped to [0, 2000])
 */
export async function isGitWorktree(dirPath: string, timeoutMs = 2000): Promise<boolean> {
  const capped = Math.max(0, Math.min(2000, timeoutMs));
  if (capped === 0) return false;
  try {
    await execFile('git', ['-C', dirPath, 'rev-parse', '--git-common-dir'], {
      timeout: capped,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Run git worktree checks bounded by concurrency and an overall deadline */
export async function checkGitWorktrees(
  paths: string[],
  budgetMs: number,
  checker: (path: string, timeoutMs: number) => Promise<boolean> = isGitWorktree,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const deadline = Date.now() + budgetMs;
  let idx = 0;

  async function worker() {
    while (idx < paths.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const p = paths[idx++]!;
      const timeout = Math.max(0, Math.min(2000, remaining));
      result.set(p, await checker(p, timeout));
    }
  }

  const pool = Array.from({ length: Math.min(GIT_CHECK_CONCURRENCY, paths.length) }, () => worker());
  await Promise.allSettled(pool);
  return result;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export interface WorkspaceBrowseOptions {
  /** Injected roots for testing (bypasses TEAMWEAVE_WORKSPACE_ROOTS) */
  allowedRootsOverride?: string[];
}

export function workspaceBrowseRoutes(opts: WorkspaceBrowseOptions = {}) {
  return async function routes(app: FastifyInstance): Promise<void> {
    // -----------------------------------------------------------------------
    // GET /api/workspace/roots
    // -----------------------------------------------------------------------
    app.get('/api/workspace/roots', async (req, reply) => {
      if (!resolveSession(app.db, req, reply)) return;

      const roots = await resolveRoots(opts.allowedRootsOverride);
      const configured = roots.length > 0;
      if (!configured) {
        return reply.send({
          roots,
          configured,
          hint: 'TEAMWEAVE_WORKSPACE_ROOTS=/path/to/parent npm run dev:server',
        });
      }
      return reply.send({ roots, configured });
    });

    // -----------------------------------------------------------------------
    // GET /api/workspace/browse?path=<abs>
    // -----------------------------------------------------------------------
    app.get('/api/workspace/browse', async (req, reply) => {
      if (!resolveSession(app.db, req, reply)) return;

      const resolvedRoots = await resolveRoots(opts.allowedRootsOverride);
      if (resolvedRoots.length === 0) {
        return reply.status(400).send({ error: 'No workspace roots configured' });
      }

      const query = (req.query as Record<string, string | undefined>);
      const rawPath = query.path;

      // Determine which directories to list
      let targets: { dir: string; parentPath: string | null }[];

      // rootMode: no ?path= → list dirs one level under each root; current=root itself
      const rootMode = !rawPath || !isAbsolute(rawPath);

      if (rootMode) {
        // No path or relative path: list one level under each root merged
        targets = resolvedRoots.map((r) => ({ dir: r, parentPath: null }));
      } else {
        // Resolve and confine the requested path
        let resolved: string;
        try {
          resolved = await realpath(rawPath);
        } catch {
          return reply.status(400).send({ error: `Path does not exist: ${rawPath}` });
        }
        try {
          assertUnderRoot(resolved, resolvedRoots);
        } catch {
          return reply.status(403).send({ error: 'Path is not under any configured workspace root' });
        }
        // F4: use path.dirname for parent, not string split
        targets = [{ dir: resolved, parentPath: resolvedRoots.includes(resolved) ? null : dirname(resolved) }];
      }

      // Collect directory entries from all targets
      const entries: { name: string; path: string }[] = [];
      for (const { dir } of targets) {
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (entries.length >= BROWSE_CAP) break;
          // F2a: exclude Git metadata directories
          if (name === '.git') continue;
          const fullPath = join(dir, name); // F4: use path.join
          try {
            const st = await lstat(fullPath);
            if (!st.isDirectory()) continue;
            // Confine each entry
            let resolvedEntry: string;
            try {
              resolvedEntry = await realpath(fullPath);
            } catch {
              continue;
            }
            try {
              assertUnderRoot(resolvedEntry, resolvedRoots);
            } catch {
              continue; // symlink escaping roots — skip silently
            }
            entries.push({ name: basename(fullPath), path: resolvedEntry });
          } catch {
            continue;
          }
          if (entries.length >= BROWSE_CAP) break;
        }
      }

      // Check git worktrees with bounded concurrency and budget
      // F2b: also check the current directory/directories themselves
      const currentDirs: string[] = rootMode
        ? resolvedRoots
        : (targets[0] ? [targets[0].dir] : []);
      const allPathsToCheck = [...entries.map((e) => e.path), ...currentDirs];
      const gitMap = await checkGitWorktrees(allPathsToCheck, GIT_CHECK_BUDGET_MS);

      const parentPath = targets.length === 1 ? targets[0]!.parentPath : null;

      // F2b: build current field(s)
      // In root mode, each root is surfaced as a current-style selectable entry.
      // In path mode, the single browsed directory is surfaced as current.
      let current: { path: string; gitWorktree: boolean } | null = null;
      if (!rootMode && targets[0]) {
        const dir = targets[0].dir;
        current = { path: dir, gitWorktree: gitMap.get(dir) ?? false };
      }

      const rootCurrentEntries: { path: string; gitWorktree: boolean }[] = rootMode
        ? resolvedRoots.map((r) => ({ path: r, gitWorktree: gitMap.get(r) ?? false }))
        : [];

      return reply.send({
        parentPath,
        entries: entries.slice(0, BROWSE_CAP).map((e) => ({
          name: e.name,
          path: e.path,
          gitWorktree: gitMap.get(e.path) ?? false,
        })),
        // F2b: current (path mode) or roots (root mode) — always included
        ...(rootMode
          ? { current: null, rootEntries: rootCurrentEntries }
          : { current }),
      });
    });

    // -----------------------------------------------------------------------
    // POST /api/workspace/validate
    // -----------------------------------------------------------------------
    app.post('/api/workspace/validate', async (req, reply) => {
      if (!resolveSession(app.db, req, reply)) return;

      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
        return reply.status(400).send({ error: 'Request body must be a JSON object' });

      const body = req.body as Record<string, unknown>;
      if (typeof body.path !== 'string' || !isAbsolute(body.path))
        return reply.status(400).send({ error: 'path must be an absolute string' });
      if (body.branch !== undefined && typeof body.branch !== 'string')
        return reply.status(400).send({ error: 'branch must be a string' });
      if (body.ref !== undefined && typeof body.ref !== 'string')
        return reply.status(400).send({ error: 'ref must be a string' });

      const path = body.path;
      // F6: trim branch and ref before use
      const branchInput = typeof body.branch === 'string' ? body.branch.trim() : '';
      const ref = (typeof body.ref === 'string' ? body.ref.trim() : '') || 'HEAD';

      const resolvedRoots = await resolveRoots(opts.allowedRootsOverride);

      // Resolve checked-out branch first (to support branch mismatch reporting)
      // We need to know the real branch even when the user's branch is wrong.
      // Use resolveBinding with the actual branch to get full validation, but
      // handle WORKSPACE_BRANCH_MISMATCH specially.
      //
      // Strategy: run resolveBinding. If it throws WORKSPACE_BRANCH_MISMATCH,
      // re-run to get the checkedOutBranch by querying git directly.

      // When branch is omitted/blank: first attempt resolveBinding; if it throws
      // WORKSPACE_BRANCH_MISMATCH, extract the actual checked-out branch from the
      // error message and retry with it — so the client-omits-branch flow succeeds
      // and the response carries the real branch for pre-filling.
      // An explicit non-empty wrong branch still fails with BRANCH_MISMATCH.
      const binding = { path, branch: branchInput || 'placeholder', ref };

      async function attemptResolve(b: typeof binding): Promise<{ worktreeRoot: string }> {
        return resolveBinding(b, resolvedRoots);
      }

      let resolvedWorktreeRoot: string;
      try {
        const { worktreeRoot } = await attemptResolve(binding);
        resolvedWorktreeRoot = worktreeRoot;
      } catch (err: unknown) {
        const e = err as Error & { code?: string };
        const code = e.code ?? 'WORKSPACE_ERROR';

        if (code === 'WORKSPACE_BRANCH_MISMATCH') {
          // F1: read structured metadata instead of parsing the error message
          const checkedOutBranch = (e as Error & { currentBranch?: string }).currentBranch;

          // If branch was blank, retry with the actual checked-out branch
          if (!branchInput && checkedOutBranch) {
            try {
              const { worktreeRoot } = await resolveBinding(
                { path, branch: checkedOutBranch, ref },
                resolvedRoots,
              );
              resolvedWorktreeRoot = worktreeRoot;
            } catch (retryErr: unknown) {
              const re = retryErr as Error & { code?: string };
              return reply.send({ ok: false, code: re.code ?? 'WORKSPACE_ERROR', message: re.message });
            }
          } else {
            // Explicit wrong branch — fail as before
            return reply.send({
              ok: false,
              code: 'BRANCH_MISMATCH',
              message: e.message,
              ...(checkedOutBranch !== undefined ? { checkedOutBranch } : {}),
            });
          }
        } else {
          return reply.send({ ok: false, code, message: e.message });
        }
      }

      // resolvedWorktreeRoot is guaranteed set here (all error paths returned above)
      const worktreeRoot = resolvedWorktreeRoot!;

      // Get HEAD commit and dirty flag
      const { stdout: commitOut } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktreeRoot });
      const commit = commitOut.trim();

      const { stdout: statusOut } = await execFile('git', ['status', '--porcelain'], { cwd: worktreeRoot });
      const dirty = statusOut.trim().length > 0;

      const { stdout: branchOut } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreeRoot });
      const checkedOutBranch = branchOut.trim();

      return reply.send({ ok: true, path, branch: checkedOutBranch, commit, dirty });
    });
  };
}
