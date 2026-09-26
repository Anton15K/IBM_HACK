/**
 * src/workspaceEditor.test.ts
 *
 * Pure logic tests for the helper functions exported from WorkspaceEditor.
 * No DOM, no React, no fetch — just the pure helper functions.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildBreadcrumb, canGoUp, normalizeEntryName } from './components/WorkspaceEditor';

// ---------------------------------------------------------------------------
// buildBreadcrumb
// ---------------------------------------------------------------------------

describe('buildBreadcrumb', () => {
  test('path matching a root exactly returns "/"', () => {
    assert.equal(buildBreadcrumb('/repos/myroot', ['/repos/myroot']), '/');
  });

  test('path under a root returns relative portion', () => {
    assert.equal(buildBreadcrumb('/repos/myroot/subdir', ['/repos/myroot']), '/subdir');
  });

  test('deeply nested path returns full relative portion', () => {
    assert.equal(
      buildBreadcrumb('/repos/myroot/a/b/c', ['/repos/myroot']),
      '/a/b/c',
    );
  });

  test('first matching root wins', () => {
    const roots = ['/repos/other', '/repos/myroot'];
    assert.equal(buildBreadcrumb('/repos/myroot/sub', roots), '/sub');
  });

  test('path not under any root returns the path itself', () => {
    const path = '/some/outside/path';
    assert.equal(buildBreadcrumb(path, ['/repos/root1', '/repos/root2']), path);
  });

  test('empty roots returns the path itself', () => {
    assert.equal(buildBreadcrumb('/foo/bar', []), '/foo/bar');
  });

  test('path that is a prefix of root but not under it returns the path', () => {
    // /repos/myroo is NOT under /repos/myroot
    assert.equal(buildBreadcrumb('/repos/myroo', ['/repos/myroot']), '/repos/myroo');
  });
});

// ---------------------------------------------------------------------------
// canGoUp
// ---------------------------------------------------------------------------

describe('canGoUp', () => {
  test('null currentPath => false', () => {
    assert.equal(canGoUp(null, ['/repos/root']), false);
  });

  test('currentPath equals a root => false (we are at root level)', () => {
    assert.equal(canGoUp('/repos/root', ['/repos/root']), false);
  });

  test('currentPath is a subdir of a root => true', () => {
    assert.equal(canGoUp('/repos/root/sub', ['/repos/root']), true);
  });

  test('currentPath not in roots and not null => true', () => {
    assert.equal(canGoUp('/repos/root/deep/path', ['/repos/root']), true);
  });

  test('multiple roots: if currentPath matches any, returns false', () => {
    const roots = ['/repos/root1', '/repos/root2'];
    assert.equal(canGoUp('/repos/root1', roots), false);
    assert.equal(canGoUp('/repos/root2', roots), false);
  });

  test('multiple roots: subpath returns true', () => {
    const roots = ['/repos/root1', '/repos/root2'];
    assert.equal(canGoUp('/repos/root1/sub', roots), true);
  });

  test('empty roots and non-null path => true', () => {
    assert.equal(canGoUp('/some/path', []), true);
  });
});

// ---------------------------------------------------------------------------
// normalizeEntryName
// ---------------------------------------------------------------------------

describe('normalizeEntryName', () => {
  test('trims leading/trailing whitespace', () => {
    assert.equal(normalizeEntryName('  myrepo  '), 'myrepo');
  });

  test('preserves internal whitespace', () => {
    assert.equal(normalizeEntryName('my repo'), 'my repo');
  });

  test('empty string returns empty string', () => {
    assert.equal(normalizeEntryName(''), '');
  });

  test('already trimmed string is unchanged', () => {
    assert.equal(normalizeEntryName('myrepo'), 'myrepo');
  });
});
