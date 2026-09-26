import type { Executor, RunInput, ProgressCb, RunOutput } from './types';
import { getStoredKeys } from './keys';

function parseOutput(text: string, nodeName: string): RunOutput {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: String(parsed.summary ?? text.slice(0, 200)),
        results: Array.isArray(parsed.results) ? parsed.results.map(String) : [],
        commands: Array.isArray(parsed.commands) ? parsed.commands.map(String) : [],
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.map(String) : [],
      };
    }
  } catch {
    // Fall through
  }
  return {
    summary: text.slice(0, 500),
    results: [],
    commands: [],
    artifacts: [`output-${nodeName.toLowerCase().replace(/\s+/g, '-')}.md`],
  };
}

const JSON_INSTRUCTION = `\n\nRespond with a JSON object in this exact format (no markdown fences):
{"summary":"<one paragraph summary>","results":["result1","result2"],"commands":["cmd1"],"artifacts":["file1.md"]}`;

export const anthropicExecutor: Executor = {
  id: 'anthropic',

  available() {
    return Boolean(getStoredKeys().anthropic);
  },

  async run(input: RunInput, cb: ProgressCb): Promise<RunOutput> {
    const { node, assembledPrompt } = input;
    const keys = getStoredKeys();
    const apiKey = keys.anthropic;
    if (!apiKey) throw new Error('Anthropic API key not set. Add it in Settings (⚙).');

    const model = node.executor.model || 'claude-sonnet-4-5';
    cb(10, 'Connecting to Anthropic…');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-request-types': 'none',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: assembledPrompt + JSON_INSTRUCTION,
          },
        ],
      }),
    });

    cb(80, 'Parsing response…');

    if (!response.ok) {
      const err = await response.text().catch(() => response.statusText);
      throw new Error(`Anthropic error ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    cb(100);
    const text = data.content?.[0]?.text ?? '';
    return parseOutput(text, node.name);
  },
};
