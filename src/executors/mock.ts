import type { Executor, RunInput, ProgressCb, RunOutput } from './types';

const MOCK_SUMMARIES: Record<string, string> = {
  worker: 'Task completed successfully. All objectives met and documented.',
  inbox: 'Investigation complete. Key findings documented with recommendations.',
  gate: 'Review complete. Ready for approval.',
};

const MOCK_RESULTS: Record<string, string[]> = {
  worker: ['Primary objective achieved', 'Edge cases handled', 'Documentation updated'],
  inbox: ['Research complete', 'Three approaches evaluated', 'Recommendation provided'],
  gate: ['Code quality verified', 'Security review passed'],
};

export const mockExecutor: Executor = {
  id: 'mock',

  available() {
    return true;
  },

  async run(input: RunInput, cb: ProgressCb): Promise<RunOutput> {
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
            summary: MOCK_SUMMARIES[node.type] ?? 'Task complete.',
            results: MOCK_RESULTS[node.type] ?? [],
            commands: [],
            artifacts: [`output-${node.name.toLowerCase().replace(/\s+/g, '-')}.md`],
          });
        }
      }, stepMs);
    });
  },
};
