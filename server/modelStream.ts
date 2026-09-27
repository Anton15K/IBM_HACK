/** Assemble bounded Chat Completions SSE, detecting empty channel loops early. */
export async function readChatStream(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder();
  let pending = '', content = '', reasoning = '', id = '', finish: string | null = null;
  let bytes = 0, ended = false;
  let usage: unknown;
  const calls = new Map<number, { id: string; type: string; function: { name: string; arguments: string } }>();
  const event = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { ended = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error('API stream returned an error');
    if (typeof chunk.id === 'string') id = chunk.id;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    for (const part of delta.tool_calls ?? []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 8) throw new Error('Invalid streamed tool index');
      const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (typeof part.id === 'string') call.id += part.id;
      if (typeof part.function?.name === 'string') call.function.name += part.function.name;
      if (typeof part.function?.arguments === 'string') call.function.arguments += part.function.arguments;
      calls.set(part.index, call);
    }
    // A normal empty thought prefix is allowed. Eight adjacent empty blocks
    // indicate degeneration, including when emitted in reasoning_content.
    if (/(?:<\|channel>(?:thought|analysis)\s*<channel\|>\s*){8}/.test(content) ||
        /(?:<\|channel>(?:thought|analysis)\s*<channel\|>\s*){8}/.test(reasoning)) {
      throw Object.assign(new Error('Local model repeated empty channel markers'), { code: 'API_DEGENERATE_RESPONSE' });
    }
  };
  try {
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('API response exceeded size limit');
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        event(pending.slice(0, newline).replace(/\r$/, ''));
        pending = pending.slice(newline + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) event(pending.trim());
    if (!finish) throw new Error('API stream ended without a finish reason');
    return JSON.stringify({ id, usage, choices: [{ finish_reason: finish, message: {
      role: 'assistant', content, tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
    } }] });
  } finally {
    await reader.cancel().catch(() => {});
  }
}
