import type { WorkerNode, GraphContext, EdgeContract, Provider } from '../types';
import type { Executor, RunInput, RunOutput } from './types';
import { mockExecutor } from './mock';
import { openaiExecutor } from './openai';
import { anthropicExecutor } from './anthropic';
import { googleExecutor } from './google';
import { bobExecutor } from './bob';

const registry: Record<Provider, Executor> = {
  mock: mockExecutor,
  openai: openaiExecutor,
  anthropic: anthropicExecutor,
  google: googleExecutor,
  bob: bobExecutor,
};

export function getExecutor(provider: Provider): Executor {
  return registry[provider] ?? mockExecutor;
}

/**
 * Assembles the prompt from graph context + node prompt + upstream inputs.
 * Returns the full text to send to the LLM.
 */
export function assemblePrompt(
  node: WorkerNode,
  graphContext: GraphContext,
  incoming: EdgeContract[]
): string {
  const parts: string[] = [];

  // System preamble from graph context
  parts.push(`## Project Context`);
  if (graphContext.goal) parts.push(`Goal: ${graphContext.goal}`);
  if (graphContext.repo) parts.push(`Repo: ${graphContext.repo}`);
  if (graphContext.conventions) parts.push(`Conventions: ${graphContext.conventions}`);

  // Node task
  parts.push(`\n## Task`);
  parts.push(node.prompt.task || '(no task description)');

  // Context files
  if (node.context.files.length > 0) {
    parts.push(`\n## Context Files`);
    node.context.files.forEach((f) => {
      parts.push(`- [${f.kind}] ${f.path}`);
    });
  }

  // Extra context
  if (node.context.extra) {
    parts.push(`\n## Extra Context`);
    parts.push(node.context.extra);
  }

  // Upstream inputs
  if (incoming.length > 0) {
    parts.push(`\n## Inputs from Upstream Nodes`);
    incoming.forEach((inp, idx) => {
      const label = `Input ${idx + 1}`;
      if (inp.summary_prev) parts.push(`\n### ${label} — Summary\n${inp.summary_prev}`);
      if (inp.results.length > 0) {
        parts.push(`### ${label} — Results`);
        inp.results.forEach((r) => parts.push(`- ${r}`));
      }
      if (inp.commands.length > 0) {
        parts.push(`### ${label} — Commands`);
        inp.commands.forEach((c) => parts.push(`\`${c}\``));
      }
      if (inp.artifacts.length > 0) {
        parts.push(`### ${label} — Artifacts`);
        inp.artifacts.forEach((a) => parts.push(`- ${a}`));
      }
    });
  }

  // Refinements
  if (node.prompt.refinements.length > 0) {
    parts.push(`\n## Refinements`);
    node.prompt.refinements.forEach((r) => {
      parts.push(`- [${r.author}] ${r.text}`);
    });
  }

  return parts.join('\n');
}

export type { RunInput, RunOutput };
