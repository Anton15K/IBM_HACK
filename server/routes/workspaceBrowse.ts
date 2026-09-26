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
import { basename, isAbsolute } from 'node:path';
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

/** Run git command with a 2s per-check timeout; returns true if exit 0 */
async function isGitWorktree(dirPath: string): Promise<boolean> {
  try {
    await execFile('git', ['-C', dirPath, 'rev-parse', '--git-common-dir'], {
      timeout: 2000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** Run git worktree checks bounded by concurrency and an overall deadline */
async function checkGitWorktrees(
  paths: string[],
  budgetMs: number,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const deadline = Date.now() + budgetMs;
  let idx = 0;

  async function worker() {
    while (idx < paths.length) {
      if (Date.now() >= deadline) return;
      const p = paths[idx++]!;
      result.set(p, await isGitWorktree(p));
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

      if (!rawPath || !isAbsolute(rawPath)) {
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
        targets = [{ dir: resolved, parentPath: resolvedRoots.includes(resolved) ? null : resolved.split('/').slice(0, -1).join('/') || '/' }];
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
          const fullPath = `${dir}/${name}`;
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
      const gitMap = await checkGitWorktrees(
        entries.map((e) => e.path),
        GIT_CHECK_BUDGET_MS,
      );

      const parentPath = targets.length === 1 ? targets[0]!.parentPath : null;

      return reply.send({
        parentPath,
        entries: entries.slice(0, BROWSE_CAP).map((e) => ({
          name: e.name,
          path: e.path,
          gitWorktree: gitMap.get(e.path) ?? false,
        })),
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
      const branchInput = typeof body.branch === 'string' ? body.branch : '';
      const ref = typeof body.ref === 'string' ? body.ref : 'HEAD';

      const resolvedRoots = await resolveRoots(opts.allowedRootsOverride);

      // Resolve checked-out branch first (to support branch mismatch reporting)
      // We need to know the real branch even when the user's branch is wrong.
      // Use resolveBinding with the actual branch to get full validation, but
      // handle WORKSPACE_BRANCH_MISMATCH specially.
      //
      // Strategy: run resolveBinding. If it throws WORKSPACE_BRANCH_MISMATCH,
      // re-run to get the checkedOutBranch by querying git directly.

      // Use resolveBinding for all validation
      const binding = { path, branch: branchInput || 'placeholder', ref };

      try {
        const { worktreeRoot } = await resolveBinding(binding, resolvedRoots);

        // Get HEAD commit and dirty flag
        const { stdout: commitOut } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: worktreeRoot });
        const commit = commitOut.trim();

        const { stdout: statusOut } = await execFile('git', ['status', '--porcelain'], { cwd: worktreeRoot });
        const dirty = statusOut.trim().length > 0;

        const { stdout: branchOut } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreeRoot });
        const checkedOutBranch = branchOut.trim();

        return reply.send({ ok: true, path, branch: checkedOutBranch, commit, dirty });
      } catch (err: unknown) {
        const e = err as Error & { code?: string };
        const code = e.code ?? 'WORKSPACE_ERROR';

        // If branch mismatch: also return checkedOutBranch
        if (code === 'WORKSPACE_BRANCH_MISMATCH') {
          // Extract the current branch from the error message or re-query
          // The error message from workspace.ts includes the current branch
          const match = /current is '([^']+)'/.exec(e.message);
          const checkedOutBranch = match ? match[1]! : undefined;
          return reply.send({
            ok: false,
            code: 'BRANCH_MISMATCH',
            message: e.message,
            ...(checkedOutBranch !== undefined ? { checkedOutBranch } : {}),
          });
        }

        return reply.send({ ok: false, code, message: e.message });
      }
    });
  };
}
