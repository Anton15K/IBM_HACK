import type { Executor, RunInput, ProgressCb, RunOutput } from './types';
import { getStoredKeys } from './keys';

function parseOutput(text: string, nodeName: string): RunOutput {
  try {
    // Try to extract JSON from the response
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
    // Fall through to plain text
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

export const openaiExecutor: Executor = {
  id: 'openai',

  available() {
    return Boolean(getStoredKeys().openai);
  },

  async run(input: RunInput, cb: ProgressCb): Promise<RunOutput> {
    const { node, assembledPrompt } = input;
    const keys = getStoredKeys();
    const apiKey = keys.openai;
    if (!apiKey) throw new Error('OpenAI API key not set. Add it in Settings (⚙).');

    const model = node.executor.model || 'gpt-4o-mini';
    cb(10, 'Connecting to OpenAI…');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: assembledPrompt + JSON_INSTRUCTION,
          },
        ],
        temperature: 0.3,
      }),
    });

    cb(80, 'Parsing response…');

    if (!response.ok) {
      const err = await response.text().catch(() => response.statusText);
      throw new Error(`OpenAI error ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    cb(100);
    const text = data.choices?.[0]?.message?.content ?? '';
    return parseOutput(text, node.name);
  },
};
