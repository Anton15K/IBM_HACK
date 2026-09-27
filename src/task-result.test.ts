import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TaskResult, { type ResultAttempt } from './components/TaskResult';
import type { WorkerNode } from './types';

const output = (summary: string) => ({ summary, results: [summary + ' result'], commands: [summary + ' command'], artifacts: [summary + '.txt'] });
function node(): WorkerNode {
  return { id: 'review', teamId: 'team', graphId: 'graph', type: 'gate', name: 'Review',
    status: 'needs_approval', priority: 'normal', progress: 0, currentAttemptId: 'current',
    prompt: { task: 'Review changes', comments: [], refinements: [] },
    executor: { provider: 'mock', model: 'mock-v1', skills: [], tools: [], maxIterations: 1 },
    context: { files: [], extra: '' }, owners: { author: 'qa', responsible: [] }, inputs: [],
    output: { summary: '', results: [], commands: [], artifacts: [] }, history: [],
    version: 1, position: { x: 0, y: 0 } };
}
const render = (task: WorkerNode, attempts: ResultAttempt[]) => renderToStaticMarkup(createElement(TaskResult, { node: task, attempts }));

test('waiting review renders only the current frozen input, not attempt output or another attempt', () => {
  const task = node();
  const frozen = output('Frozen patch');
  const html = render(task, [
    { id: 'older', nodeId: task.id, status: 'done', incoming: [{ fromNodeId: 'upstream', ...output('Stale snapshot') }] },
    { id: 'current', nodeId: 'different', status: 'waiting', incoming: [{ fromNodeId: 'other', ...output('Wrong task') }] },
    { id: 'current', nodeId: task.id, status: 'waiting', output: output('Not the input'),
      incoming: [{ fromNodeId: 'worker-1', attemptId: 'upstream-1', ...frozen, output: frozen }] },
  ]);
  for (const value of ['Frozen patch', 'Frozen patch result', 'Frozen patch command', 'Frozen patch.txt', 'worker-1', 'upstream-1']) assert.ok(html.includes(value), value);
  for (const value of ['Stale snapshot', 'Wrong task', 'Not the input']) assert.ok(!html.includes(value), value);
});

test('review reports unloaded and empty inputs without substituting retained results', () => {
  const task = node();
  assert.match(render(task, []), /Loading review inputs/);
  const attempt = { id: 'current', nodeId: task.id, status: 'waiting' };
  assert.match(render(task, [attempt]), /not recorded/);
  assert.match(render(task, [{ ...attempt, incoming: [] }]), /No incoming artifacts/);
});

test('completed, invalidated and failed gates retain visible results with honest status', () => {
  const task = node();
  task.output = output('Previously approved');
  task.status = 'done';
  assert.match(render(task, []), /Previously approved.txt/);
  assert.doesNotMatch(render(task, []), /Retained result/);
  task.status = 'needs_approval';
  const html = render(task, [{ id: 'current', nodeId: task.id, status: 'waiting',
    incoming: [{ fromNodeId: 'worker', ...output('New frozen input') }] }]);
  assert.match(html, /New frozen input/);
  assert.match(html, /Previously approved/);
  assert.match(html, /Not a current approval or completion/);
  task.status = 'failed';
  assert.match(render(task, [{ id: 'current', nodeId: task.id, status: 'failed', error: 'Review canceled' }]), /Review canceled/);
  assert.match(render(task, []), /Previously approved/);
});

test('failed worker exposes current error while preserving and escaping previous output', () => {
  const task = node(); task.type = 'worker'; task.status = 'failed'; task.output = output('<script>retained</script>');
  const html = render(task, [{ id: 'current', nodeId: task.id, status: 'failed', error: 'Provider unavailable' }]);
  assert.match(html, /Provider unavailable/);
  assert.match(html, /&lt;script&gt;retained/);
  assert.doesNotMatch(html, /<script>/);
});
