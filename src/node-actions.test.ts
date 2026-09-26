import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedWorkerInputsReady, requestTaskDeletion } from './node-actions';
import type { WorkerNode } from './types';
const worker = (id: string, status: WorkerNode['status'], patch: Partial<WorkerNode> = {}): WorkerNode => ({
  id, name: id, type: 'worker', status, graphId: 'g', teamId: 't', inputs: [], ...patch,
} as WorkerNode);

test('blocked worker becomes retryable only after enabled same-graph inputs finish', () => {
  const target = worker('target', 'blocked', { inputs: [{ fromNodeId: 'source', enabled: true }] });
  for (const status of ['draft', 'running', 'failed', 'needs_approval', 'rework'] as const)
    assert.equal(blockedWorkerInputsReady(target, [worker('source', status)]), false);
  assert.equal(blockedWorkerInputsReady(target, [worker('source', 'done')]), true);
  assert.equal(target.status, 'blocked'); // UI never invents a server state.
  assert.equal(blockedWorkerInputsReady(target, []), false);
  assert.equal(blockedWorkerInputsReady(target, [worker('source', 'done', { graphId: 'other' })]), false);
  assert.equal(blockedWorkerInputsReady(target, [worker('source', 'done', { teamId: 'other' })]), false);
});
test('disabled inputs do not block retry; gates, inboxes and active workers are unchanged', () => {
  const target = worker('target', 'blocked', { inputs: [{ fromNodeId: 'missing', enabled: false }] });
  assert.equal(blockedWorkerInputsReady(target, []), true);
  for (const type of ['gate', 'inbox'] as const) assert.equal(blockedWorkerInputsReady({ ...target, type }, []), false);
  for (const status of ['running', 'queued', 'done', 'draft'] as const) assert.equal(blockedWorkerInputsReady({ ...target, status }, []), false);
});
test('canceling deletion never invokes the remove/API action; confirmation deletes the exact task once', async () => {
  const target = { id: 'n', name: 'Important task' };
  const calls: string[] = [];
  let message = '';
  const remove = async (id: string) => { calls.push(id); };
  await requestTaskDeletion(target, text => { message = text; return false; }, remove);
  assert.deepEqual(calls, []);
  assert.match(message, /Important task/);
  assert.match(message, /attempt history/);
  await requestTaskDeletion(target, () => true, remove);
  assert.deepEqual(calls, ['n']);
});
