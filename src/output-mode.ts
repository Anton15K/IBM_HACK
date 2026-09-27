import type { WorkerNode } from './types.js';

/** Shared by the editor, prompt and executors, including legacy nodes without a mode. */
export function resolveOutputMode(node: Pick<WorkerNode, 'desiredOutput' | 'executor'>): NonNullable<WorkerNode['desiredOutput']> {
  return node.desiredOutput ?? (node.executor.skills.includes('research') ? 'report' : 'patch');
}
