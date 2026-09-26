import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolListFiles, MAX_TOOL_OUTPUT_BYTES } from './modelTools.js';

test('long Unicode listings stay within the byte limit without splitting a character', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tw-list-unicode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let directory = root;
  for (let depth = 0; depth < 6; depth++) {
    directory = join(directory, 'é'.repeat(40));
    await mkdir(directory);
  }
  await Promise.all(Array.from({ length: 220 }, (_, i) =>
    writeFile(join(directory, 'é'.repeat(20) + String(i).padStart(3, '0')), '')));
  const listing = await toolListFiles({}, root);
  assert.ok(!listing.startsWith('Error:'), listing);
  assert.ok(Buffer.byteLength(listing) <= MAX_TOOL_OUTPUT_BYTES,
    `received ${Buffer.byteLength(listing)} bytes, limit ${MAX_TOOL_OUTPUT_BYTES}`);
  assert.ok(!listing.includes('\uFFFD'), 'truncation must not introduce a replacement character');
});
