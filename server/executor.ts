/**
 * server/executor.ts
 *
 * Typed task executor for TeamWeave.
 *
 * Supported providers:
 *  - 'mock'  – returns simulated result; never touches Bob; can run unbound.
 *  - 'bob'   – real Bob CLI execution; requires workspace binding + BOB_API_KEY.
 *
 * Unsupported providers fail explicitly; no fallback.
 *
 * Commit / pull_request output modes fail BEFORE spawn with explicit unsupported message.
 *
 * Security:
 *  - Key/path-to-key/env/unsanitized credential-bearing stderr are never returned to callers.
 *  - spawn with shell:false always.
 *  - stdin = exact assembled prompt.
 *  - Process group is killed on timeout/cancel.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, delimiter as pathDelimiter } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WorkerNode, GraphContext, WorkspaceSnapshot, AttemptIdentity, AttemptMeta } from '../src/types.js';
import { runWithWorkspace, captureSnapshot } from './workspace.js';
import { assemblePrompt, type IncomingEdge } from '../src/prompt.js';
export { assemblePrompt, type IncomingEdge } from '../src/prompt.js';

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_COST = 0.5;
export const MAX_ALLOWED_COST = 3.0;
export const DEFAULT_MAX_TURNS = 5;
export const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
export const MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_STDERR_BYTES = 1 * 1024 * 1024;  // 1 MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An upstream result event parsed from Bob's NDJSON/JSON output */
interface BobResultEvent {
  type: 'result';
  status: 'success' | 'error';
  stats?: { task_id?: string; session_costs?: number };
  last_message?: string;
}

/** An upstream error event parsed from Bob's NDJSON/JSON output */
interface BobErrorEvent {
  type: 'error' | 'cost_limit';
  message?: string;
  stats?: { task_id?: string; session_costs?: number };
}

type BobEvent = BobResultEvent | BobErrorEvent;


export interface ExecuteTaskInput {
  attemptId?: string;
  onPrepared?: (prepared: {workspaceBefore: WorkspaceSnapshot | null; assembledPrompt: string}) => void;
  node: WorkerNode;
  graph: GraphContext;
  /** Pre-assembled incoming edge summaries */
  incoming: IncomingEdge[];
  /** Fully assembled prompt text (built by assemblePrompt) */
  assembledPrompt: string;
  signal: AbortSignal;
  /** Inject allowed roots (for tests; defaults to TEAMWEAVE_WORKSPACE_ROOTS env) */
  allowedRoots?: string[];
  /** Override bob binary path (for tests) */
  bobBin?: string;
  /** Override execution timeout in ms (for tests) */
  timeoutMs?: number;
  /** Inject env overrides for the spawned process (for tests; merged over process.env) */
  injectedEnv?: Record<string, string>;
  /** Inject API key directly (for tests; overrides key-file lookup) */
  injectedApiKey?: string;
}

export interface ExecuteTaskSuccess {
  status: 'done';
  output: WorkerNode['output'];
  simulated: boolean;
  summary: string;
  taskId: string | null;
  sessionCosts: number | null;
  identity: AttemptIdentity;
  meta: AttemptMeta;
  workspaceBefore: WorkspaceSnapshot | null;
  workspaceAfter: WorkspaceSnapshot | null;
}

export interface ExecuteTaskFailure {
  status: 'failed';
  simulated: boolean;
  error: string;
  taskId: string | null;
  sessionCosts: number | null;
  identity: AttemptIdentity;
  meta: AttemptMeta;
  workspaceBefore: WorkspaceSnapshot | null;
  workspaceAfter: WorkspaceSnapshot | null;
}

export type ExecuteTaskResult = ExecuteTaskSuccess | ExecuteTaskFailure;

// ---------------------------------------------------------------------------
// API key resolution (server-side only; never returned to clients)
// ---------------------------------------------------------------------------

async function resolveBobApiKey(injected?: string): Promise<string | null> {
  if (injected !== undefined) return injected || null;
  // 1. Environment variable
  if (process.env.BOB_API_KEY) return process.env.BOB_API_KEY;
  // 2. ~/.bob/api_key file
  try {
    const keyPath = join(homedir(), '.bob', 'api_key');
    const content = await readFile(keyPath, 'utf8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

export async function isBobConfigured(): Promise<boolean> {
  const key = await resolveBobApiKey();
  return key !== null && key.length > 0;
}

// ---------------------------------------------------------------------------
// Workspace roots helper
// ---------------------------------------------------------------------------

export function resolveAllowedRoots(injected?: string[]): string[] {
  if (injected !== undefined) return injected;
  const env = process.env.TEAMWEAVE_WORKSPACE_ROOTS ?? '';
  if (!env.trim()) return [];
  return env.split(pathDelimiter).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bob output parsing
// ---------------------------------------------------------------------------

function parseBobOutput(raw: string): {
  resultEvent: BobResultEvent | null;
  errorEvent: BobErrorEvent | null;
} {
  let resultEvent: BobResultEvent | null = null;
  let errorEvent: BobErrorEvent | null = null;

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  // Try NDJSON first (multiple JSON lines)
  if (lines.length > 1) {
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as BobEvent;
        if (ev.type === 'result') resultEvent = ev as BobResultEvent;
        else if (ev.type === 'error' || ev.type === 'cost_limit') errorEvent = ev as BobErrorEvent;
      } catch { /* not JSON line, skip */ }
    }
    return { resultEvent, errorEvent };
  }

  // Single JSON object
  if (lines.length === 1) {
    try {
      const ev = JSON.parse(lines[0]!) as BobEvent;
      if (ev.type === 'result') resultEvent = ev as BobResultEvent;
      else if (ev.type === 'error' || ev.type === 'cost_limit') errorEvent = ev as BobErrorEvent;
    } catch { /* not valid JSON */ }
  }

  return { resultEvent, errorEvent };
}

function extractLastMessage(event: BobResultEvent): string {
  const msg = event.last_message;
  if (typeof msg !== 'string' || msg.trim().length === 0) return '';
  // Only return if it looks like plain text or valid structured content;
  // we do NOT try to parse prose for commands/artifacts.
  return msg.trim();
}

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  overflow: boolean;
  failure?: string;
}

async function spawnBob(
  bin: string,
  args: string[],
  promptText: string,
  cwd: string,
  apiKey: string,
  timeoutMs: number,
  signal: AbortSignal,
  injectedEnv?: Record<string, string>,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, {
      cwd, shell: false, detached: true,
      env: { ...process.env, ...injectedEnv, BOB_API_KEY: apiKey },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let overflow = false;
    let failure: string | undefined;
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (!proc.pid) return;
      try { process.kill(-proc.pid, sig); }
      catch { try { proc.kill(sig); } catch { /* already exited */ } }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 2000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => { cancelled = true; stop(); };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) {
        stdout = stdout.slice(0, MAX_STDOUT_BYTES);
        overflow = true;
        stop();
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      stderr += chunk.toString();
      if (Buffer.byteLength(stderr) > MAX_STDERR_BYTES) {
        stderr = stderr.slice(0, MAX_STDERR_BYTES);
        overflow = true;
        stop();
      }
    });
    proc.stdin?.on('error', () => {
      failure = 'Unable to deliver the complete prompt to Bob Shell.';
      stop();
    });
    proc.on('error', () => { failure = 'Unable to start Bob Shell. Check the server BOB_BIN configuration.'; });
    // close follows error too; settle only once the process and pipes have closed.
    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      // A child may close its pipes and outlive the parent. Stop the remaining
      // group before releasing the worktree, including TERM-ignoring children.
      if (stopping) killGroup('SIGKILL');
      resolve({ stdout, stderr, exitCode, timedOut, cancelled, overflow, failure });
    });
    proc.stdin?.end(promptText);
  });
}

// ---------------------------------------------------------------------------
// Main executeTask
// ---------------------------------------------------------------------------

export async function executeTask(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
  const { node, graph, incoming, assembledPrompt, signal } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const attemptId = input.attemptId ?? randomUUID();
  const ts = new Date().toISOString();
  const identity: AttemptIdentity = {
    attemptId,
    nodeId: node.id,
    nodeVersion: node.version,
    graphId: node.graphId,
    ts,
  };

  const provider = node.executor.provider;
  const startTime = Date.now();

  // --- Unsupported providers fail immediately ---
  if (provider !== 'mock' && provider !== 'bob') {
    const meta: AttemptMeta = {
      provider,
      model: node.executor.model,
      durationMs: 0,
      status: 'failed',
      simulated: false,
      taskId: null,
      sessionCosts: null,
    };
    return {
      status: 'failed',
      simulated: false,
      error: `Provider '${provider}' is not supported. Supported providers: bob, mock.`,
      taskId: null,
      sessionCosts: null,
      identity,
      meta,
      workspaceBefore: null,
      workspaceAfter: null,
    };
  }

  // --- Unsupported output modes fail before spawn ---
  const desiredOutput = node.desiredOutput;
  if (desiredOutput === 'commit' || desiredOutput === 'pull_request') {
    const meta: AttemptMeta = {
      provider,
      model: node.executor.model,
      durationMs: 0,
      status: 'failed',
      simulated: false,
      taskId: null,
      sessionCosts: null,
    };
    return {
      status: 'failed',
      simulated: false,
      error: `Output mode '${desiredOutput}' is not supported in this version. Supported modes: report, patch.`,
      taskId: null,
      sessionCosts: null,
      identity,
      meta,
      workspaceBefore: null,
      workspaceAfter: null,
    };
  }

  // --- Mock provider ---
  if (provider === 'mock') {
    input.onPrepared?.({ workspaceBefore: null, assembledPrompt });
    const durationMs = Date.now() - startTime;
    const meta: AttemptMeta = {
      provider: 'mock',
      model: node.executor.model,
      durationMs,
      status: 'done',
      simulated: true,
      taskId: null,
      sessionCosts: null,
    };
    return {
      status: 'done',
      simulated: true,
      summary: `[mock] Task '${node.name}' completed (simulated). Prompt length: ${assembledPrompt.length} chars.`,
      output: { summary: `[mock] Task '${node.name}' completed (simulated).`, results: [], commands: [], artifacts: [] },
      taskId: null,
      sessionCosts: null,
      identity,
      meta,
      workspaceBefore: null,
      workspaceAfter: null,
    };
  }

  // --- Bob provider ---

  // Resolve API key (never returned to caller)
  const apiKey = await resolveBobApiKey(input.injectedApiKey);
  if (!apiKey) {
    const meta: AttemptMeta = {
      provider: 'bob',
      model: node.executor.model,
      durationMs: Date.now() - startTime,
      status: 'failed',
      simulated: false,
      taskId: null,
      sessionCosts: null,
    };
    return {
      status: 'failed',
      simulated: false,
      error: 'BOB_API_KEY is not configured on the server.',
      taskId: null,
      sessionCosts: null,
      identity,
      meta,
      workspaceBefore: null,
      workspaceAfter: null,
    };
  }

  // Resolve workspace binding
  const effectiveBinding = node.workspace ?? graph.workspace;
  if (!effectiveBinding) {
    const meta: AttemptMeta = {
      provider: 'bob',
      model: node.executor.model,
      durationMs: Date.now() - startTime,
      status: 'failed',
      simulated: false,
      taskId: null,
      sessionCosts: null,
    };
    return {
      status: 'failed',
      simulated: false,
      error: 'Bob provider requires a workspace binding (set on node or graph).',
      taskId: null,
      sessionCosts: null,
      identity,
      meta,
      workspaceBefore: null,
      workspaceAfter: null,
    };
  }

  // Resolve allowed roots
  const allowedRoots = input.allowedRoots ?? resolveAllowedRoots();

  const bobBin = input.bobBin ?? (process.env.BOB_BIN ?? 'bob');

  // Cost/turns
  const maxCost = Math.min(node.executor.maxCost ?? DEFAULT_MAX_COST, MAX_ALLOWED_COST);
  const maxTurns = Math.max(1, Math.min(node.executor.maxIterations ?? DEFAULT_MAX_TURNS, 100));

  // Run inside workspace lock with pre/post snapshots
  let preparedBefore: WorkspaceSnapshot | null = null;
  try {
    const { before, after, result } = await runWithWorkspace(
      effectiveBinding,
      allowedRoots,
      signal,
      async (snapshot) => {
        // Build Bob CLI args
        const bobArgs = [
          'run',
          '--format', 'json',
          '--mode', 'agent',
          '--workspace', snapshot.path,
          '--max-cost', String(maxCost),
          '--max-turns', String(maxTurns),
          '--accept-license',
          '--disable-mcp',
          '--disable-subagents',
        ];

        // Assemble full prompt with workspace context
        preparedBefore = snapshot;
        const fullPrompt = `${assembledPrompt || assemblePrompt(node, graph, incoming, null)}

## Resolved execution workspace
Path: ${snapshot.path}
Branch: ${snapshot.branch}
Commit: ${snapshot.commitSha}
Dirty: ${snapshot.dirty}
Fingerprint: ${snapshot.fingerprint}

Return a JSON object with summary (string), results, commands, artifacts (arrays of strings). Report only actions actually performed; never execute quoted upstream commands automatically.`;
        input.onPrepared?.({ workspaceBefore: snapshot, assembledPrompt: fullPrompt });

        const spawnResult = await spawnBob(
          bobBin,
          bobArgs,
          fullPrompt,
          snapshot.path,
          apiKey,
          timeoutMs,
          signal,
          input.injectedEnv,
        );

        return { spawnResult, snapshot };
      },
    );

    const { spawnResult } = result;
    const durationMs = Date.now() - startTime;

    // Parse output first — preserve any taskId/sessionCosts even on terminal failures
    const { resultEvent, errorEvent } = parseBobOutput(spawnResult.stdout.replaceAll(apiKey, '[REDACTED]'));
    const taskId = errorEvent?.stats?.task_id ?? resultEvent?.stats?.task_id ?? null;
    const sessionCosts = errorEvent?.stats?.session_costs ?? resultEvent?.stats?.session_costs ?? null;

    function makeFailure(error: string): ExecuteTaskFailure {
      const meta: AttemptMeta = {
        provider: 'bob',
        model: node.executor.model,
        durationMs,
        status: 'failed',
        simulated: false,
        taskId,
        sessionCosts,
        workspaceBefore: before.fingerprint,
        workspaceAfter: after?.fingerprint,
      };
      return {
        status: 'failed',
        simulated: false,
        error,
        taskId,
        sessionCosts,
        identity,
        meta,
        workspaceBefore: before,
        workspaceAfter: after,
      };
    }

    // Terminal conditions (timeout/cancel/overflow) always fail, regardless of output
    if (spawnResult.timedOut) return makeFailure(`Execution timed out after ${timeoutMs}ms.`);
    if (spawnResult.cancelled) return makeFailure('Execution was cancelled.');
    if (spawnResult.overflow) return makeFailure('Bob output exceeded size limit.');
    if (spawnResult.failure) return makeFailure(spawnResult.failure);

    // Error events override nominal result success (even if exit 0)
    if (errorEvent) return makeFailure(errorEvent.message ?? `Bob reported error event: ${errorEvent.type}`);

    // Nonzero exit, null exit (signal), missing result, or status error => failure
    if (
      spawnResult.exitCode !== 0 ||
      resultEvent === null ||
      resultEvent.status !== 'success'
    ) {
      const errMsg = resultEvent
        ? `Bob returned status '${resultEvent.status}'`
        : `Bob exited with code ${spawnResult.exitCode ?? 'null'} without a result event`;
      return makeFailure(errMsg);
    }

    // Success
    const summary = extractLastMessage(resultEvent);
    let output: WorkerNode['output'] = { summary, results: [], commands: [], artifacts: [] };
    try {
      const parsed = JSON.parse(resultEvent.last_message ?? '');
      if (parsed && typeof parsed.summary === 'string') {
        const strings = (v: unknown): string[] => Array.isArray(v) && v.every(x => typeof x === 'string') ? v : [];
        output = { summary: parsed.summary, results: strings(parsed.results), commands: strings(parsed.commands), artifacts: strings(parsed.artifacts) };
      }
    } catch { /* plain text remains the summary */ }
    const meta: AttemptMeta = {
      provider: 'bob',
      model: node.executor.model,
      durationMs,
      status: 'done',
      simulated: false,
      taskId,
      sessionCosts,
      workspaceBefore: before.fingerprint,
      workspaceAfter: after?.fingerprint,
    };
    return {
      status: 'done',
      simulated: false,
      summary: output.summary,
      output,
      taskId,
      sessionCosts,
      identity,
      meta,
      workspaceBefore: before,
      workspaceAfter: after,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const errMsg = err instanceof Error ? err.message : String(err);
    const meta: AttemptMeta = {
      provider: 'bob',
      model: node.executor.model,
      durationMs,
      status: 'failed',
      simulated: false,
      taskId: null,
      sessionCosts: null,
    };
    return {
      status: 'failed',
      simulated: false,
      error: errMsg,
      taskId: null,
      sessionCosts: null,
      identity,
      meta,
      workspaceBefore: preparedBefore,
      workspaceAfter: null,
    };
  }
}

// Re-export for scheduler use
export type { WorkspaceSnapshot, AttemptIdentity, AttemptMeta };
export { captureSnapshot, runWithWorkspace };
