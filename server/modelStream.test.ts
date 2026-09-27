import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatStream } from './modelStream.js';

function stream(events: unknown[], finish = true) {
  const raw = events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join('') + (finish ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(raw);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }).getReader();
}

test('SSE preserves split UTF-8, indexed tool arguments and final usage', async () => {
  const result = JSON.parse(await readChatStream(stream([
    { id: 'request', choices: [{ delta: { content: 'Тест', tool_calls: [{ index: 0, id: 'call', function: { name: 'write_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.md","content":"ok"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
  ]), 10000));
  assert.equal(result.choices[0].message.content, 'Тест');
  assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments), { path: 'a.md', content: 'ok' });
  assert.equal(result.usage.total_tokens, 30);
});

test('SSE aborts an empty channel loop before waiting for the next token', async () => {
  let canceled = false;
  const reader = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '<|channel>thought\n<channel|>'.repeat(8) } }] }) + '\n\n'));
    // The provider never closes; detection must cancel the generation.
  }, cancel() { canceled = true; } }).getReader();
  await assert.rejects(readChatStream(reader, 10000), { code: 'API_DEGENERATE_RESPONSE' });
  assert.equal(canceled, true);
});

test('SSE rejects truncated responses and respects the byte bound', async () => {
  await assert.rejects(readChatStream(stream([{ choices: [{ delta: { content: 'Partial answer' } }] }], false), 10000), /finish reason/);
  await assert.rejects(readChatStream(stream([{ choices: [{ delta: { content: 'too long' }, finish_reason: 'stop' }] }]), 8), /size limit/);
});
