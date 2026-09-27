import type { NodeTemplate } from './types.js';

export const BUILTIN_TEMPLATES: NodeTemplate[] = [
  {
    id: 'tpl-code-review',
    name: 'Code Review',
    description: 'Review code for quality, security, and best practices',
    isBuiltIn: true,
    defaults: {
      desiredOutput: 'report',
      type: 'worker',
      priority: 'normal',
      prompt: {
        task: 'Review the provided code changes. Check for correctness, security issues, performance, code style, and test coverage. Return a review report with concrete findings and a recommendation. Do not modify files; a human gate handles approval separately.',
        refinements: [],
        comments: [],
      },
      executor: { provider: 'bob', model: 'bob-4', skills: ['code-review'], tools: ['list_files', 'read_file'], maxIterations: 12, maxOutputTokens: 4096 },
      context: { files: [], extra: '' },
    },
  },
  {
    id: 'tpl-write-tests',
    name: 'Write Tests',
    description: 'Generate comprehensive tests for a module',
    isBuiltIn: true,
    defaults: {
      desiredOutput: 'patch',
      type: 'worker',
      priority: 'normal',
      prompt: {
        task: 'Write comprehensive unit and integration tests. Aim for >80% coverage. Include happy path, edge cases, and error scenarios.',
        refinements: [],
        comments: [],
      },
      executor: { provider: 'bob', model: 'bob-4', skills: ['testing'], tools: ['code-editor', 'terminal'], maxIterations: 16, maxOutputTokens: 4096 },
      context: { files: [], extra: '' },
    },
  },
  {
    id: 'tpl-fix-bug',
    name: 'Fix Bug',
    description: 'Diagnose and fix a reported bug',
    isBuiltIn: true,
    defaults: {
      desiredOutput: 'patch',
      type: 'worker',
      priority: 'high',
      prompt: {
        task: 'Diagnose the reported bug. Find root cause, implement fix, ensure no regression. Document the cause, fix and verification in the final report. Do not commit or push.',
        refinements: [],
        comments: [],
      },
      executor: { provider: 'bob', model: 'bob-4', skills: ['debugging', 'backend'], tools: ['code-editor', 'terminal', 'debugger'], maxIterations: 16, maxOutputTokens: 4096 },
      context: { files: [], extra: '' },
    },
  },
  {
    id: 'tpl-investigate',
    name: 'Investigate',
    description: 'Research and document findings on a technical topic',
    isBuiltIn: true,
    defaults: {
      desiredOutput: 'report',
      type: 'worker',
      priority: 'normal',
      prompt: {
        task: 'Investigate the topic using the supplied context and available workspace files. Compare at least 3 approaches. Do not claim web research without a web tool. Document findings, trade-offs, and a clear recommendation.',
        refinements: [],
        comments: [],
      },
      executor: { provider: 'bob', model: 'bob-4', skills: ['research'], tools: ['list_files', 'read_file'], maxIterations: 12, maxOutputTokens: 4096 },
      context: { files: [], extra: '' },
    },
  },
];
