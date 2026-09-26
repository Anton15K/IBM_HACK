import type { WorkerNode } from './types';
import type { IncomingEdge } from './prompt';

/** Advisory preview only; runtime resolves immutable attempts independently. */
export function previewInputs(node: WorkerNode, nodes: WorkerNode[]) {
  const incoming: IncomingEdge[] = [];
  const unavailableInputIds: string[] = [];
  for (const input of node.inputs.filter((i) => i.enabled)) {
    const source = nodes.find((n) => n.id === input.fromNodeId);
    // Reruns retain the previous output while currentAttemptId already points
    // at the new attempt. Only a completed current result is safe to label.
    if (source?.status === 'done' && source.currentAttemptId && source.graphId === node.graphId) {
      incoming.push({ fromNodeId: source.id, attemptId: source.currentAttemptId, ...source.output });
    } else {
      unavailableInputIds.push(input.fromNodeId);
    }
  }
  if (node.inboxMeta?.sourceOutput) {
    incoming.push({ fromNodeId: node.inboxMeta.sourceNodeId,
      attemptId: node.inboxMeta.sourceAttemptId, ...node.inboxMeta.sourceOutput });
  }
  return { incoming, unavailableInputIds };
}
