import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertUnderRoot } from './workspace.js';

const exec = promisify(execFile);
const publicHosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);
const fail = (message: string, statusCode = 400): never => {
  throw Object.assign(new Error(message), { statusCode });
};

export function publicCloneUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048)
    return fail('Enter a public HTTPS repository URL');
  let url: URL;
  try { url = new URL(value); } catch { return fail('Enter a public HTTPS repository URL'); }
  if (url.protocol !== 'https:' || !publicHosts.has(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash ||
      !/^\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+\/?$/.test(url.pathname))
    return fail('Use a public HTTPS URL from github.com, gitlab.com or bitbucket.org, without credentials');
  return url.href;
}

function isolatedGitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false' });
  return env;
}

export async function clonePublicRepository(url: string, destination: string): Promise<string> {
  // Disable Git credential helpers, URL rewrites, templates and hooks. Never prompt.
  const options = { env: isolatedGitEnv(), timeout: 90_000, maxBuffer: 1024 * 1024 };
  const config = ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false'];
  await exec('git', [...config, 'clone', '--template=', '--depth=1', '--single-branch', '--', url, destination], options);
  const { stdout } = await exec('git', ['-C', destination, 'symbolic-ref', '--short', 'HEAD'], options);
  await exec('git', ['-C', destination, 'rev-parse', '--verify', 'HEAD'], options);
  return stdout.trim();
}

async function initializeRepository(destination: string): Promise<string> {
  const options = { env: isolatedGitEnv(), timeout: 10_000, maxBuffer: 1024 * 1024 };
  await exec('git', ['init', '--template=', '--initial-branch=main', '--', destination], options);
  // The runner needs a resolvable HEAD. Disclose this empty setup commit in the UI.
  await exec('git', ['-C', destination, '-c', 'core.hooksPath=/dev/null',
    '-c', 'commit.gpgsign=false', '-c', 'user.name=TeamWeave', '-c', 'user.email=teamweave@localhost',
    'commit', '--allow-empty', '-m', 'Initialize workspace'], options);
  return 'main';
}

export async function createWorkspace(
  body: unknown,
  roots: string[],
  clone: (url: string, destination: string) => Promise<string> = clonePublicRepository,
): Promise<{ path: string; branch?: string; ref?: string }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Invalid request');
  const { parentPath, name, kind, url } = body as Record<string, unknown>;
  if (kind !== 'folder' && kind !== 'clone' && kind !== 'init') return fail('Choose folder, new Git repository or clone');
  if (typeof parentPath !== 'string' || !isAbsolute(parentPath)) return fail('Choose a parent folder');
  if (typeof name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,79}$/.test(name) || name.trim() !== name || name.endsWith('.'))
    return fail('Folder name must be 1–80 characters without slashes, leading dots or trailing spaces');
  const cloneUrl = kind === 'clone' ? publicCloneUrl(url) : undefined;
  let parent: string;
  try { parent = await realpath(parentPath); } catch { return fail('Parent folder does not exist'); }
  try { assertUnderRoot(parent, roots); } catch { return fail('Parent folder is outside configured workspace roots', 403); }
  if (!(await stat(parent)).isDirectory()) return fail('Parent must be a folder');
  const path = join(parent, name);
  try { await mkdir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('A folder or file with that name already exists', 409);
    return fail('Cannot create folder on the server');
  }
  if (kind === 'folder') return { path };
  try {
    const branch = kind === 'init' ? await initializeRepository(path) : await clone(cloneUrl!, path);
    return { path, branch, ref: 'HEAD' };
  } catch {
    // This target was created exclusively by this request; never remove an existing path.
    await rm(path, { recursive: true, force: true });
    if (kind === 'init') return fail('Could not initialize the Git repository on the server.', 422);
    return fail('Clone failed or timed out. Check that the repository is public, non-empty and the HTTPS URL is correct.', 422);
  }
}
