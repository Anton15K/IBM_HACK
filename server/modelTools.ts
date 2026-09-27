/**
 * server/modelTools.ts
 *
 * Tool definitions and implementations for the API executor.
 *
 * Provided tools: list_files, read_file, write_file, run_tests.
 *
 * Security rules:
 *  - All paths resolved via realpath; symlinks outside the workspace are rejected.
 *  - .git/, .env, credential, and private-key files are blocked.
 *  - Absolute paths, .., and null bytes are rejected.
 *  - read_file and list_files are available in all modes.
 *  - write_file and run_tests require desiredOutput === 'patch'.
 *  - run_tests uses a fixed command: node --test, cwd=snapshot.path, shell:false.
 *  - Restricted child environment: only PATH, TMPDIR, LANG.
 *  - Output bounded to 64 KiB.
 *  - Max 8 tool calls per model response.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { writeFile, lstat, open, opendir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

// Constants

export const MAX_FILE_BYTES = 64 * 1024;      // Read limit: 64 KiB
export const MAX_WRITE_FILE_BYTES = 256 * 1024; // Write limit: 256 KiB
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
export const MAX_LIST_ENTRIES = 200;
export const MAX_TEST_OUTPUT_BYTES = 64 * 1024;
export const TEST_TIMEOUT_MS = 20_000;

// Blocked filename patterns

const BLOCKED_FILENAME_RE = /(?:^|[/\\])(?:\.env|\.env\..+|api[_-]?key|.*credentials?.*|.*secret.*|.*password.*|.*private[_-]?key.*|.*\.pem|.*\.key)$/i;

function isBlockedFile(name: string): boolean {
  return BLOCKED_FILENAME_RE.test(name) || /^(?:id_rsa|id_ed25519|\.npmrc|\.netrc|\.teamweave_model_key)$/i.test(name);
}

const BLOCKED_DIR_RE = /(?:^|[/\\])(?:\.git|node_modules|\.ssh|\.aws|\.bob|\.\x63\x6f\x64\x65\x78)(?:[/\\]|$)/;

function isBlockedDir(relPath: string): boolean {
  return BLOCKED_DIR_RE.test(relPath);
}

// Path safety helper

async function safeResolve(rawPath: string, workspaceRoot: string): Promise<{ resolved: string } | { error: string }> {
  if (typeof rawPath !== 'string' || rawPath.includes('\0') || isAbsolute(rawPath)) return { error: 'Expected a relative path' };
  const parts = rawPath.split(/[\\/]/).filter(p => p !== '.' && p !== '');
  if (parts.includes('..') || parts.some(p => isBlockedFile(p) || isBlockedDir(p))) return { error: 'Path is not allowed' };
  let cursor = workspaceRoot;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]!);
    try {
      const st = await lstat(cursor);
      if (st.isSymbolicLink()) return { error: 'Symlink paths are not supported' };
      if (i < parts.length - 1 && !st.isDirectory()) return { error: 'Parent is not a directory' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && i === parts.length - 1) break;
      return { error: 'Path is unavailable' };
    }
  }
  return { resolved: cursor };
}

export async function toolListFiles(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
  const check = await safeResolve(typeof args.path === 'string' ? args.path : '.', workspaceRoot);
  if ('error' in check) return `Error: ${check.error}`;
  const entries: string[] = [];
  async function visit(path: string, prefix = ''): Promise<void> {
    // Read one directory at a time, prune blocked directories before descending.
    const dir = await opendir(path);
    for await (const entry of dir) {
      if (entries.length >= MAX_LIST_ENTRIES) break;
      if (entry.isSymbolicLink() || isBlockedFile(entry.name) || isBlockedDir(entry.name)) continue;
      const rel = prefix + entry.name;
      entries.push(rel + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) await visit(join(path, entry.name), rel + '/');
    }
  }
  try { await visit(check.resolved); }
  catch { return 'Error: directory is unavailable'; }
  // Leave an incomplete trailing UTF-8 character buffered rather than emitting a replacement.
  return new StringDecoder('utf8').write(
    Buffer.from(entries.join('\n') || '(empty directory)').subarray(0, MAX_TOOL_OUTPUT_BYTES),
  );
}

export async function toolReadFile(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
  if (typeof args.path !== 'string' || !args.path) return 'Error: path is required';
  const check = await safeResolve(args.path, workspaceRoot);
  if ('error' in check) return `Error: ${check.error}`;
  try {
    const st = await lstat(check.resolved);
    if (!st.isFile()) return 'Error: expected a regular file';
    const file = await open(check.resolved, 'r');
    try {
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, Math.min(bytesRead, MAX_FILE_BYTES)).toString('utf8') + (bytesRead > MAX_FILE_BYTES ? '\n[file truncated]' : '');
    } finally { await file.close(); }
  } catch { return 'Error: file is unavailable'; }
}

export async function toolWriteFile(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
  if (typeof args.path !== 'string' || !args.path || typeof args.content !== 'string') return 'Error: path and content are required';
  if (Buffer.byteLength(args.content) > MAX_WRITE_FILE_BYTES) return 'Error: content exceeds 256 KiB';
  const check = await safeResolve(args.path, workspaceRoot);
  if ('error' in check) return `Error: ${check.error}`;
  try {
    const st = await lstat(check.resolved).catch((err: NodeJS.ErrnoException) => { if (err.code !== 'ENOENT') throw err; return null; });
    if (st && !st.isFile()) return 'Error: expected a regular file';
    await writeFile(check.resolved, args.content, 'utf8');
    return `Written ${Buffer.byteLength(args.content)} bytes to ${args.path}`;
  } catch { return 'Error: cannot write file'; }
}

// Tool: run_tests

export async function toolRunTests(
  args: Record<string, unknown>,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<string> {
  // Fixed command: node --test, no arbitrary args
  void args; // tool takes no meaningful args
  if (signal.aborted) return 'Error: canceled before test execution';

  const restrictedEnv: Record<string, string> = {};
  if (process.env.PATH) restrictedEnv.PATH = process.env.PATH;
  if (process.env.TMPDIR) restrictedEnv.TMPDIR = process.env.TMPDIR;
  if (process.env.LANG) restrictedEnv.LANG = process.env.LANG;

  return new Promise<string>((resolve) => {
    const proc = spawn(process.execPath, ['--test'], {
      cwd: workspaceRoot,
      shell: false,
      detached: true,
      env: restrictedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (!proc.pid) return;
      try { process.kill(-proc.pid, sig); } catch { try { proc.kill(sig); } catch { /* already gone */ } }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 2000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, TEST_TIMEOUT_MS);
    const onAbort = () => stop();
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    let outputBytes = 0;
    const append = (chunk: Buffer) => {
      const part = chunk.subarray(0, Math.max(0, MAX_TEST_OUTPUT_BYTES - outputBytes));
      outputBytes += part.length;
      output += part.toString('utf8');
    };

    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      if (stopping) killGroup('SIGKILL');
      const suffix = timedOut ? '\n[timed out after 20s]' : signal.aborted ? '\n[cancelled]' : '';
      resolve(`Exit code: ${exitCode ?? 'null'}\n${output}${suffix}`.slice(0, MAX_TEST_OUTPUT_BYTES));
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      resolve(`Error starting test runner: ${e.message}`);
    });
  });
}

// Tool dispatch

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
}

/**
 * Dispatch a tool call against the workspace.
 * `reportOnly` disables write_file and run_tests.
 */
export async function dispatchTool(
  call: ToolCall,
  workspaceRoot: string,
  reportOnly: boolean,
  signal: AbortSignal,
): Promise<ToolResult> {
  const { id, name, arguments: args } = call;
  if (signal.aborted) return { id, content: 'Error: canceled' };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { id, content: 'Error: arguments must be an object' };

  let content: string;
  try {
    switch (name) {
      case 'list_files':
        content = await toolListFiles(args, workspaceRoot);
        break;
      case 'read_file':
        content = await toolReadFile(args, workspaceRoot);
        break;
      case 'write_file':
        if (reportOnly) {
          content = 'Error: write_file is not available in report mode';
        } else {
          content = await toolWriteFile(args, workspaceRoot);
        }
        break;
      case 'run_tests':
        if (reportOnly) {
          content = 'Error: run_tests is not available in report mode';
        } else {
          content = await toolRunTests(args, workspaceRoot, signal);
        }
        break;
      default:
        content = `Error: unknown tool '${name}'`;
    }
  } catch (e: unknown) {
    content = `Error: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Bound tool output
  if (Buffer.byteLength(content) > MAX_TOOL_OUTPUT_BYTES) {
    content = content.slice(0, MAX_TOOL_OUTPUT_BYTES) + '\n[output truncated]';
  }

  return { id, content };
}

// Tool schema definitions for the model

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the workspace directory (excludes .git, node_modules, .env, credential files)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path within workspace to list (default: ".")' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace (max 64 KiB)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to file within workspace' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file in the workspace (max 256 KiB; patch mode only)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to file within workspace' },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: 'Run project tests with node --test (patch mode only). Returns exit code and output.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];
