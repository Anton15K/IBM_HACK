import type { Executor, RunInput, ProgressCb, RunOutput } from './types';
import { getStoredKeys } from './keys';

const SIM_SUMMARIES: Record<string, string> = {
  worker: 'Task completed successfully. All objectives met and documented.',
  inbox: 'Investigation complete. Key findings documented with recommendations.',
  gate: 'Review complete. Ready for approval.',
};

const SIM_RESULTS: Record<string, string[]> = {
  worker: ['Primary objective achieved', 'Edge cases handled', 'Documentation updated'],
  inbox: ['Research complete', 'Three approaches evaluated', 'Recommendation provided'],
  gate: ['Code quality verified', 'Security review passed'],
};

async function simulateRun(input: RunInput, cb: ProgressCb): Promise<RunOutput> {
  const { node } = input;
  const steps = 20;
  const stepMs = 200;

  return new Promise((resolve) => {
    let step = 0;
    const interval = setInterval(() => {
      step++;
      const pct = Math.min(Math.round((step / steps) * 100), 100);
      cb(pct, step === 10 ? 'Processing…' : undefined);
      if (step >= steps) {
        clearInterval(interval);
        resolve({
          summary:
            '[Simulated — Bob Gateway not connected] ' +
            (SIM_SUMMARIES[node.type] ?? 'Task complete.'),
          results: SIM_RESULTS[node.type] ?? [],
          commands: [],
          artifacts: [`output-${node.name.toLowerCase().replace(/\s+/g, '-')}.md`],
          simulated: true,
        });
      }
    }, stepMs);
  });
}

export const bobExecutor: Executor = {
  id: 'bob',

  available() {
    // Bob gateway is assumed reachable if configured; we mark available optimistically
    return true;
  },

  async run(input: RunInput, cb: ProgressCb): Promise<RunOutput> {
    const { node, assembledPrompt, graphContext } = input;
    const keys = getStoredKeys();
    const gatewayUrl = keys.bobGatewayUrl || 'http://localhost:7142';
    cb(5, 'Connecting to Bob Gateway…');

    let response: Response;
    try {
      response = await fetch(`${gatewayUrl}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: node.executor.model || 'bob-4',
          prompt: assembledPrompt,
          skills: node.executor.skills,
          tools: node.executor.tools,
          maxIterations: node.executor.maxIterations,
          graphContext,
        }),
      });
    } catch {
      // Gateway unreachable — fall back to simulated run
      return simulateRun(input, cb);
    }

    cb(80, 'Parsing response…');

    if (!response.ok) {
      const err = await response.text().catch(() => response.statusText);
      throw new Error(`Bob Gateway error ${response.status}: ${err.slice(0, 200)}`);
    }

    const data = await response.json();
    cb(100);

    return {
      summary: String(data.summary ?? ''),
      results: Array.isArray(data.results) ? data.results.map(String) : [],
      commands: Array.isArray(data.commands) ? data.commands.map(String) : [],
      artifacts: Array.isArray(data.artifacts) ? data.artifacts.map(String) : [],
    };
  },
};
