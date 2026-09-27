import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleHierarchyChildren } from './client-helpers';
import type { Team } from './types';
const team = (id: string, parentId: string | null, kind: Team['kind']): Team => ({ id, name: id, parentId, kind, space: { x: 0, y: 0, w: 1200, h: 480 } });
test('implicit organization home preserves organization children and legacy root siblings', () => {
  const teams = [team('org', null, 'organization'), team('dept', 'org', 'department'), team('legacy', null, 'team'), team('nested', 'dept', 'team')];
  assert.deepEqual(visibleHierarchyChildren(teams, null).map(t => t.id), ['dept', 'legacy']);
  assert.deepEqual(visibleHierarchyChildren(teams, 'dept').map(t => t.id), ['nested']);
  assert.equal(teams[1].parentId, 'org');
});
test('home also works without an organization container in legacy or scoped data', () => {
  assert.deepEqual(visibleHierarchyChildren([team('dept', null, 'department')], null).map(t => t.id), ['dept']);
});
