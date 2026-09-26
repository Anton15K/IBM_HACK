import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputPresentation, type OutputAttempt } from './output-presentation';
import type { WorkerNode } from './types';

function gate(): WorkerNode {
  return { id: 'gate', teamId: 'team', graphId: 'graph', name: 'Review', type: 'gate',
    status: 'done', priority: 'normal', progress: 100, currentAttemptId: 'approved-1',
    prompt: { task: '', refinements: [], comments: [] },
    executor: { provider: 'mock', model: 'mock', skills: [], tools: [], maxIterations: 1 },
    context: { files: [], extra: '' }, owners: { author: 'qa', responsible: [] }, inputs: [],
    output: { summary: 'Approved', results: ['Tests passed'], commands: [], artifacts: [] },
    history: [{ ts: '2026-09-27T00:00:00Z', provider: 'mock', model: 'mock', status: 'done',
      summary: 'Approved', durationMs: 1, attemptId: 'approved-1' }],
    version: 1, position: { x: 0, y: 0 } };
}
function attempt(node: WorkerNode): OutputAttempt {
  return { nodeId: node.id, id: node.currentAttemptId!, status: 'done', output: structuredClone(node.output) };
}

test('approved gate becomes retained through invalidation, rerun, failure and reapproval', () => {
  const node = gate();
  const previous = attempt(node);
  assert.equal(outputPresentation(node, [previous]).label, null);
  for (const status of ['blocked', 'rework', 'queued', 'running', 'needs_approval', 'failed'] as const) {
    node.status = status;
    if (status !== 'blocked' && status !== 'rework') node.currentAttemptId = 'review-2';
    const before = structuredClone({ node, previous });
    const presentation = outputPresentation(node, [previous]);
    assert.equal(presentation.retained, true, status);
    assert.match(presentation.label!, /completed attempt approved-1/);
    assert.match(presentation.label!, /Not a current approval or completion/);
    assert.doesNotMatch(presentation.label!, /review-2/);
    assert.deepEqual({ node, previous }, before, 'presentation must not change output/history');
  }
  node.status = 'done';
  node.output.summary = 'Approved: revised work';
  // Node polling may arrive before the attempt list. Current success is not stale.
  assert.deepEqual(outputPresentation(node, [previous]), { retained: false, label: null });
});

test('retained output is labelled before attempts load without guessing provenance', () => {
  const node = gate(); node.status = 'needs_approval'; node.currentAttemptId = 'review-2';
  assert.match(outputPresentation(node, []).label!, /Retained result/);
  assert.doesNotMatch(outputPresentation(node, []).label!, /approved-1|review-2/);
  const previous = attempt(gate());
  for (const candidate of [
    { ...previous, nodeId: 'other-node' },
    { ...previous, status: 'failed' },
    { ...previous, output: { ...previous.output!, results: ['Different result'] } },
  ]) assert.doesNotMatch(outputPresentation(node, [candidate]).label!, /completed attempt/);
  node.history = [];
  assert.doesNotMatch(outputPresentation(node, [previous]).label!, /completed attempt/);
});

test('fresh waiting gate has no retained-result warning; array-only old output does', () => {
  const node = gate(); node.status = 'needs_approval';
  node.output = { summary: '', results: [], commands: [], artifacts: [] };
  assert.deepEqual(outputPresentation(node, []), { retained: false, label: null });
  node.output.artifacts = ['previous.patch'];
  assert.equal(outputPresentation(node, []).retained, true);
});
