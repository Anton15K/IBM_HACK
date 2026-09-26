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

export const googleExecutor: Executor = {
  id: 'google',

  available() {
    return Boolean(getStoredKeys().google);
  },

  async run(input: RunInput, cb: ProgressCb): Promise<RunOutput> {
    const { node, assembledPrompt } = input;
    const keys = getStoredKeys();
    const apiKey = keys.google;
    if (!apiKey) throw new Error('Google API key not set. Add it in Settings (⚙).');

    const model = node.executor.model || 'gemini-2.0-flash';
    cb(10, 'Connecting to Google AI…');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: assembledPrompt + JSON_INSTRUCTION }],
          },
        ],
        generationConfig: {
          temperature: 0.3,
        },
      }),
    });

    cb(80, 'Parsing response…');

    if (!response.ok) {
      const err = await response.text().catch(() => response.statusText);
      throw new Error(`Google AI error ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    cb(100);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return parseOutput(text, node.name);
  },
};
