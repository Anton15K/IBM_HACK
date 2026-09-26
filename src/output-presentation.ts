import type { WorkerNode } from './types';

export interface OutputAttempt {
  id: string;
  nodeId: string;
  status: string;
  output?: WorkerNode['output'];
}

function sameOutput(a: WorkerNode['output'], b: WorkerNode['output']) {
  return a.summary === b.summary &&
    (['results', 'commands', 'artifacts'] as const).every((key) =>
      a[key].length === b[key].length && a[key].every((value, i) => value === b[key][i]));
}

/** Output survives reruns and invalidation; it is not the node's current status. */
export function outputPresentation(node: WorkerNode, attempts: OutputAttempt[]) {
  const hasOutput = !!node.output.summary ||
    [node.output.results, node.output.commands, node.output.artifacts].some((values) => values.length > 0);
  const retained = hasOutput && node.status !== 'done';
  // Do not infer provenance from currentAttemptId: a new attempt can retain an
  // older output. Require the latest successful history entry and its snapshot.
  const lastSuccess = [...node.history].reverse().find((entry) => entry.status === 'done');
  const source = retained && lastSuccess?.attemptId
    ? attempts.find((attempt) => attempt.nodeId === node.id && attempt.id === lastSuccess.attemptId &&
      attempt.status === 'done' && attempt.output && sameOutput(attempt.output, node.output))
    : undefined;
  return {
    retained,
    label: retained
      ? `Retained result${source ? ` from completed attempt ${source.id}` : ' from an earlier execution'}. Not a current approval or completion.`
      : null,
  };
}
