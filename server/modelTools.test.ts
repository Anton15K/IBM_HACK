import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolListFiles, toolWriteFile, MAX_WRITE_FILE_BYTES, MAX_TOOL_OUTPUT_BYTES } from './modelTools.js';

test('writes 10000 Cyrillic words and rejects oversized replacements without changing the file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tw-large-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = 'пупупу\n'.repeat(10000);
  assert.ok(Buffer.byteLength(content) > 64 * 1024);
  assert.match(await toolWriteFile({ path: 'words.txt', content }, root), /^Written /);
  assert.equal(await readFile(join(root, 'words.txt'), 'utf8'), content);
  assert.match(await toolWriteFile({ path: 'words.txt', content: 'x'.repeat(MAX_WRITE_FILE_BYTES + 1) }, root), /^Error: content exceeds 256 KiB/);
  assert.equal(await readFile(join(root, 'words.txt'), 'utf8'), content);
});

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
