import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlacementGesture } from './canvas-gesture';

test('a card-to-pane gesture cannot place a node even within click tolerance', () => {
  const g = new PlacementGesture();
  g.start(1, 10, 10, false);
  g.end(1, 11, 10, true);
  assert.equal(g.consume(11, 10), false);
});

test('pane drags cannot place nodes, including moving away and returning', () => {
  const g = new PlacementGesture();
  g.start(1, 10, 10, true);
  g.move(1, 40, 40);
  g.end(1, 10, 10, true);
  assert.equal(g.consume(10, 10), false);
  g.start(1, 10, 10, true);
  g.end(1, 30, 30, true);
  assert.equal(g.consume(30, 30), false);
});

test('a genuine pane click is accepted exactly once with small pointer jitter', () => {
  const g = new PlacementGesture();
  g.start(1, 10, 10, true);
  g.move(1, 11, 12);
  g.end(1, 11, 12, true);
  assert.equal(g.consume(11, 12), true);
  assert.equal(g.consume(11, 12), false);
});

test('cancel, unmatched pointer, missing release and non-pane release reject placement', () => {
  const g = new PlacementGesture();
  g.start(1, 10, 10, true);
  g.end(1, 10, 10, true);
  g.cancel();
  assert.equal(g.consume(10, 10), false);
  g.start(1, 10, 10, true);
  g.end(2, 10, 10, true);
  assert.equal(g.consume(10, 10), false);
  g.start(1, 10, 10, true);
  assert.equal(g.consume(10, 10), false);
  g.start(1, 10, 10, true);
  g.end(1, 10, 10, false);
  assert.equal(g.consume(10, 10), false);
});


test('a fractional pointer release accepts browser-floored click coordinates once', () => {
  for (const [x, y] of [[330.5, 280.75], [-0.25, -1.75]]) {
    const g = new PlacementGesture();
    g.start(1, x, y, true);
    g.end(1, x, y, true);
    assert.equal(g.consume(Math.floor(x), Math.floor(y)), true);
    assert.equal(g.consume(Math.floor(x), Math.floor(y)), false);
  }
});

test('rounding compatibility still rejects a different click location', () => {
  const g = new PlacementGesture();
  g.start(1, 330.5, 280.75, true);
  g.end(1, 330.5, 280.75, true);
  assert.equal(g.consume(331, 280), false);
});
