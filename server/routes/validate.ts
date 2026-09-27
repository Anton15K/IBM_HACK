/**
 * Shared validation helpers for node create/update and template defaults.
 *
 * Rules:
 * - validateNodeFields()  – validates every editable nested structure.
 *   Returns null on success, or a string error message.
 * - validateWorkspaceBinding() – validates a WorkspaceBinding object.
 * - ALLOWED_DEFINITION_KEYS – the set of keys permitted in template defaults.
 * - SERVER_ONLY_NODE_KEYS   – fields that must never appear in client payloads.
 */

import { isAbsolute } from 'node:path';
import type { WorkerNode, WorkspaceBinding } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NODE_TYPES = new Set<string>(['worker', 'gate', 'inbox']);
export const PRIORITIES  = new Set<string>(['low', 'normal', 'high', 'critical']);
export const PROVIDERS   = new Set<string>(['bob', 'openai', 'anthropic', 'google', 'mock', 'api']);
export const DESIRED_OUTPUTS = new Set<string>(['report', 'patch', 'commit', 'pull_request']);

/**
 * Fields the server controls — clients must never include these in
 * create or patch payloads.
 */
export const SERVER_ONLY_NODE_KEYS = new Set([
  'status', 'progress', 'output', 'history', 'id', 'version', 'inboxMeta', 'currentAttemptId', 'runId',
]);

/**
 * Fields allowed in NodeTemplate.defaults (a subset of WorkerNode fields).
 * The keys status, output, id, workspace, and credentials must never appear.
 */
export const ALLOWED_DEFINITION_KEYS = new Set<string>([
  'type', 'prompt', 'executor', 'context', 'priority',
]);

// ---------------------------------------------------------------------------
// WorkspaceBinding validator
// ---------------------------------------------------------------------------

/** Returns an error string, or null if valid. */
export function validateWorkspaceBinding(v: unknown, field = 'workspace'): string | null {
  if (v === null || v === undefined) return null; // absence is fine; null is a clear signal
  if (typeof v !== 'object' || Array.isArray(v))
    return `${field} must be an object`;
  const w = v as Record<string, unknown>;
  if (typeof w.path !== 'string' || w.path.trim().length === 0)
    return `${field}.path must be a non-empty string`;
  if (!isAbsolute(w.path))
    return `${field}.path must be an absolute path`;
  if (typeof w.branch !== 'string' || w.branch.trim().length === 0)
    return `${field}.branch must be a non-empty string`;
  if (typeof w.ref !== 'string' || w.ref.trim().length === 0)
    return `${field}.ref must be a non-empty string`;
  return null;
}

// ---------------------------------------------------------------------------
// Refinement / comment entry validator
// ---------------------------------------------------------------------------

function validateEntryArray(v: unknown, field: string): string | null {
  if (!Array.isArray(v)) return `${field} must be an array`;
  for (let i = 0; i < v.length; i++) {
    const e = v[i];
    if (typeof e !== 'object' || e === null || Array.isArray(e))
      return `${field}[${i}] must be an object`;
    const obj = e as Record<string, unknown>;
    if (typeof obj.ts !== 'string')     return `${field}[${i}].ts must be a string`;
    if (typeof obj.author !== 'string') return `${field}[${i}].author must be a string`;
    if (typeof obj.text !== 'string')   return `${field}[${i}].text must be a string`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// prompt validator
// ---------------------------------------------------------------------------

export function validatePrompt(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    return 'prompt must be an object';
  const p = v as Record<string, unknown>;
  if (typeof p.task !== 'string') return 'prompt.task must be a string';
  const refErr = validateEntryArray(p.refinements, 'prompt.refinements');
  if (refErr) return refErr;
  const cmtErr = validateEntryArray(p.comments, 'prompt.comments');
  if (cmtErr) return cmtErr;
  return null;
}

// ---------------------------------------------------------------------------
// executor validator
// ---------------------------------------------------------------------------

export function validateExecutor(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    return 'executor must be an object';
  const e = v as Record<string, unknown>;

  if (!PROVIDERS.has(e.provider as string))
    return `executor.provider must be one of: ${[...PROVIDERS].join(', ')}`;
  if (typeof e.model !== 'string')
    return 'executor.model must be a string';

  // skills
  if (!Array.isArray(e.skills)) return 'executor.skills must be an array';
  for (let i = 0; i < (e.skills as unknown[]).length; i++) {
    if (typeof (e.skills as unknown[])[i] !== 'string')
      return `executor.skills[${i}] must be a string`;
  }
  // tools
  if (!Array.isArray(e.tools)) return 'executor.tools must be an array';
  for (let i = 0; i < (e.tools as unknown[]).length; i++) {
    if (typeof (e.tools as unknown[])[i] !== 'string')
      return `executor.tools[${i}] must be a string`;
  }
  // maxIterations
  if (!Number.isInteger(e.maxIterations) ||
      (e.maxIterations as number) < 1 ||
      (e.maxIterations as number) > 100)
    return 'executor.maxIterations must be an integer between 1 and 100';

  // maxCost (optional)
  if (e.maxCost !== undefined) {
    if (typeof e.maxCost !== 'number' ||
        !Number.isFinite(e.maxCost) ||
        e.maxCost <= 0 ||
        e.maxCost > 3)
      return 'executor.maxCost must be a finite number > 0 and <= 3';
  }

  // maxAttempts (optional)
  if (e.maxAttempts !== undefined) {
    if (!Number.isInteger(e.maxAttempts) ||
        (e.maxAttempts as number) < 1 ||
        (e.maxAttempts as number) > 10)
      return 'executor.maxAttempts must be an integer between 1 and 10';
  }

  // connectionId (required when provider='api', optional otherwise)
  if (e.provider === 'api') {
    if (typeof e.connectionId !== 'string' || e.connectionId.trim().length === 0)
      return 'executor.connectionId is required when provider is api';
  }
  if (e.connectionId !== undefined && typeof e.connectionId !== 'string')
    return 'executor.connectionId must be a string';

  // maxOutputTokens (optional; 64–65536)
  if (e.maxOutputTokens !== undefined) {
    if (!Number.isInteger(e.maxOutputTokens) ||
        (e.maxOutputTokens as number) < 64 ||
        (e.maxOutputTokens as number) > 65536)
      return 'executor.maxOutputTokens must be an integer between 64 and 65536';
  }

  return null;
}

// ---------------------------------------------------------------------------
// context validator
// ---------------------------------------------------------------------------

export function validateContext(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    return 'context must be an object';
  const c = v as Record<string, unknown>;
  if (!Array.isArray(c.files)) return 'context.files must be an array';
  for (let i = 0; i < (c.files as unknown[]).length; i++) {
    const f = (c.files as unknown[])[i];
    if (typeof f !== 'object' || f === null || Array.isArray(f))
      return `context.files[${i}] must be an object`;
    const obj = f as Record<string, unknown>;
    if (typeof obj.path !== 'string') return `context.files[${i}].path must be a string`;
    if (obj.kind !== 'glob' && obj.kind !== 'file')
      return `context.files[${i}].kind must be 'glob' or 'file'`;
  }
  if (typeof c.extra !== 'string') return 'context.extra must be a string';
  return null;
}

// ---------------------------------------------------------------------------
// owners validator
// ---------------------------------------------------------------------------

export function validateOwners(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    return 'owners must be an object';
  const o = v as Record<string, unknown>;
  if (typeof o.author !== 'string') return 'owners.author must be a string';
  if (!Array.isArray(o.responsible)) return 'owners.responsible must be an array';
  for (let i = 0; i < (o.responsible as unknown[]).length; i++) {
    if (typeof (o.responsible as unknown[])[i] !== 'string')
      return `owners.responsible[${i}] must be a string`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// inputs validator
// ---------------------------------------------------------------------------

export function validateInputs(v: unknown): string | null {
  if (!Array.isArray(v)) return 'inputs must be an array';
  for (let i = 0; i < (v as unknown[]).length; i++) {
    const inp = (v as unknown[])[i];
    if (typeof inp !== 'object' || inp === null || Array.isArray(inp))
      return `inputs[${i}] must be an object`;
    const obj = inp as Record<string, unknown>;
    if (typeof obj.fromNodeId !== 'string')
      return `inputs[${i}].fromNodeId must be a string`;
    if (typeof obj.enabled !== 'boolean')
      return `inputs[${i}].enabled must be a boolean`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Full editable node fields validator
// Used for both POST (when caller supplies a field) and PATCH.
// ---------------------------------------------------------------------------

/**
 * Validates all editable nested structures when they are present in the
 * payload.  Returns null on success, or an error message string.
 *
 * @param body       - raw request body (Record<string, unknown>)
 * @param forCreate  - when true, also validates type/priority/desiredOutput
 *                     enum values; for PATCH these may be omitted
 */
export function validateNodeFields(
  body: Record<string, unknown>,
  forCreate = false,
): string | null {
  // type
  if (body.type !== undefined) {
    if (!NODE_TYPES.has(body.type as string))
      return `type must be one of: ${[...NODE_TYPES].join(', ')}`;
  }

  // priority
  if (body.priority !== undefined) {
    if (!PRIORITIES.has(body.priority as string))
      return `priority must be one of: ${[...PRIORITIES].join(', ')}`;
  }

  // desiredOutput
  if (body.desiredOutput !== undefined && body.desiredOutput !== null) {
    if (!DESIRED_OUTPUTS.has(body.desiredOutput as string))
      return `desiredOutput must be one of: ${[...DESIRED_OUTPUTS].join(', ')}`;
  }

  // position
  if (body.position !== undefined) {
    if (typeof body.position !== 'object' || body.position === null || Array.isArray(body.position))
      return 'position must be an object';
    const pos = body.position as Record<string, unknown>;
    if (typeof pos.x !== 'number' || !Number.isFinite(pos.x))
      return 'position.x must be a finite number';
    if (typeof pos.y !== 'number' || !Number.isFinite(pos.y))
      return 'position.y must be a finite number';
  }

  // prompt
  if (body.prompt !== undefined) {
    const err = validatePrompt(body.prompt);
    if (err) return err;
  }

  // executor
  if (body.executor !== undefined) {
    const err = validateExecutor(body.executor);
    if (err) return err;
  }

  // context
  if (body.context !== undefined) {
    const err = validateContext(body.context);
    if (err) return err;
  }

  // owners
  if (body.owners !== undefined) {
    const err = validateOwners(body.owners);
    if (err) return err;
  }

  // inputs
  if (body.inputs !== undefined) {
    const err = validateInputs(body.inputs);
    if (err) return err;
  }

  // workspace (null is allowed as a clear signal)
  if (body.workspace !== undefined && body.workspace !== null) {
    const err = validateWorkspaceBinding(body.workspace, 'workspace');
    if (err) return err;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Template defaults validator
// ---------------------------------------------------------------------------

/**
 * Validates the `defaults` object supplied when creating/updating a template.
 * Returns an error string, or null if valid.
 */
export function validateTemplateDefaults(defaults: unknown): string | null {
  if (defaults === undefined || defaults === null) return null; // empty defaults fine
  if (typeof defaults !== 'object' || Array.isArray(defaults))
    return 'defaults must be an object';

  const d = defaults as Record<string, unknown>;

  // Reject keys that must never appear in template defaults
  const forbidden = ['status', 'output', 'id', 'workspace', 'credentials',
                     'progress', 'history', 'version', 'inboxMeta'];
  for (const k of forbidden) {
    if (k in d) return `defaults must not contain '${k}'`;
  }

  if (d.type !== undefined && !NODE_TYPES.has(d.type as string))
    return `defaults.type must be one of: ${[...NODE_TYPES].join(', ')}`;
  if (d.priority !== undefined && !PRIORITIES.has(d.priority as string))
    return `defaults.priority must be one of: ${[...PRIORITIES].join(', ')}`;
  if (d.desiredOutput !== undefined && !DESIRED_OUTPUTS.has(d.desiredOutput as string))
    return `defaults.desiredOutput must be one of: ${[...DESIRED_OUTPUTS].join(', ')}`;

  if (d.prompt !== undefined) {
    const err = validatePrompt(d.prompt);
    if (err) return `defaults.${err}`;
  }
  if (d.executor !== undefined) {
    const err = validateExecutor(d.executor);
    if (err) return `defaults.${err}`;
  }
  if (d.context !== undefined) {
    const err = validateContext(d.context);
    if (err) return `defaults.${err}`;
  }

  return null;
}
