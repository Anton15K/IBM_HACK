import type { WorkerNode } from './types';

/** A UI hint only; the server revalidates attempts, permissions and workspace. */
export function blockedWorkerInputsReady(node: WorkerNode, nodes: WorkerNode[]): boolean {
  return node.type === 'worker' && node.status === 'blocked' &&
    node.inputs.filter(input => input.enabled).every(input => nodes.some(source =>
      source.id === input.fromNodeId && source.teamId === node.teamId &&
      source.graphId === node.graphId && source.status === 'done'));
}

export function requestTaskDeletion(
  node: Pick<WorkerNode, 'id' | 'name'>,
  confirm: (message: string) => boolean,
  remove: (id: string) => Promise<void>,
): Promise<void> | undefined {
  if (!confirm(`Delete task “${node.name}”? Its prompt and saved attempt history will be removed. This cannot be undone.`)) return;
  return remove(node.id);
}
