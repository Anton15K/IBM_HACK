import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamPositions } from './canvas-layout';
import type { Team } from './types';

const team = (id: string, x = 0, y = 0, kind: Team['kind'] = 'team'): Team => ({
  id, name: id, kind, parentId: null, space: { x, y, w: 1200, h: 480 },
});

test('legacy teams and departments remain separately visible without changing saved positions', () => {
  const teams = [team('a'), team('b', 0, 0, 'department'), team('c')];
  const before = structuredClone(teams);
  const positions = teamPositions(teams);
  assert.equal(new Set([...positions.values()].map((p) => JSON.stringify(p))).size, 3);
  assert.deepEqual(teams, before);
  assert.deepEqual(teamPositions([...teams].reverse()), positions);
});

test('preserves explicit zero axes and fractional coordinates while avoiding occupied fallback slots', () => {
  const teams = [team('a'), team('b'), team('fixed', 300, 0), team('vertical', 0, -12.5)];
  const positions = teamPositions(teams);
  assert.deepEqual(positions.get('a'), { x: 0, y: 0 });
  assert.deepEqual(positions.get('fixed'), { x: 300, y: 0 });
  assert.deepEqual(positions.get('vertical'), { x: 0, y: -12.5 });
  assert.deepEqual(positions.get('b'), { x: 600, y: 0 });
});

test('a team moved away from the default origin keeps its persisted position', () => {
  const positions = teamPositions([team('a'), team('b', -90, 35)]);
  assert.deepEqual(positions.get('a'), { x: 0, y: 0 });
  assert.deepEqual(positions.get('b'), { x: -90, y: 35 });
});
