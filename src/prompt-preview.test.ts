import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewInputs } from './prompt-preview';
import { assemblePrompt } from './prompt';
import type { WorkerNode } from './types';

function fixture(id: string): WorkerNode {
  return { id, teamId: 'team', graphId: 'graph', name: id, type: 'worker',
    status: 'done', currentAttemptId: 'success-' + id, priority: 'normal', progress: 100,
    prompt: { task: '', refinements: [], comments: [] },
    executor: { provider: 'mock', model: 'mock', skills: [], tools: [], maxIterations: 1 },
    context: { files: [], extra: '' }, owners: { author: 'qa', responsible: [] },
    inputs: [], output: { summary: 'old-success-result', results: ['retained-result'], commands: [], artifacts: [] },
    history: [], version: 1, position: { x: 0, y: 0 } };
}
const graph = { id: 'graph', teamId: 'team', goal: '', repo: '', conventions: '' };

test('rerun retains old output but preview never attributes it to the new attempt', () => {
  const source = fixture('source');
  const target = fixture('target');
  target.inputs = [{ fromNodeId: source.id, enabled: true }];
  const initial = previewInputs(target, [source]);
  assert.match(assemblePrompt(target, graph, initial.incoming, null), /attempt success-source/);
  assert.match(assemblePrompt(target, graph, initial.incoming, null), /old-success-result/);
  for (const status of ['queued', 'running', 'failed', 'blocked', 'rework', 'needs_approval', 'draft', 'ready'] as const) {
    source.currentAttemptId = 'new-rerun';
    source.status = status;
    const preview = previewInputs(target, [source]);
    const text = assemblePrompt(target, graph, preview.incoming, null);
    assert.doesNotMatch(text, /old-success-result|retained-result|new-rerun/, status);
    assert.deepEqual(preview.unavailableInputIds, ['source']);
  }
  source.status = 'done';
  source.output = { ...source.output, summary: 'new-result', results: [] };
  const finished = previewInputs(target, [source]);
  assert.match(assemblePrompt(target, graph, finished.incoming, null), /attempt new-rerun/);
  assert.match(assemblePrompt(target, graph, finished.incoming, null), /new-result/);
});

test('disabled, missing, cross-graph and unrecorded inputs cannot supply preview results', () => {
  const target = fixture('target');
  const disabled = fixture('disabled'), foreign = fixture('foreign'), unrecorded = fixture('unrecorded');
  foreign.graphId = 'another-graph';
  delete unrecorded.currentAttemptId;
  target.inputs = [
    { fromNodeId: 'disabled', enabled: false }, { fromNodeId: 'missing', enabled: true },
    { fromNodeId: 'foreign', enabled: true }, { fromNodeId: 'unrecorded', enabled: true },
  ];
  assert.deepEqual(previewInputs(target, [disabled, foreign, unrecorded]), {
    incoming: [], unavailableInputIds: ['missing', 'foreign', 'unrecorded'],
  });
});

test('handoff preserves its pinned snapshot even when the source reruns or is not visible', () => {
  const target = fixture('target');
  const source = fixture('source');
  target.inboxMeta = { sourceNodeId: source.id, sourceTeamId: 'private-team',
    sourceAttemptId: 'pinned-success', sourceOutput: structuredClone(source.output), message: 'handoff' };
  source.status = 'running'; source.currentAttemptId = 'new-rerun';
  source.output.summary = 'different-result';
  for (const visible of [[], [source]]) {
    const preview = previewInputs(target, visible);
    assert.deepEqual(preview.unavailableInputIds, []);
    assert.equal(preview.incoming[0]?.attemptId, 'pinned-success');
    assert.equal(preview.incoming[0]?.summary, 'old-success-result');
  }
});
