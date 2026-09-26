import type { WorkerNode, GraphContext, EdgeContract, Provider } from '../types';

export interface RunInput {
  node: WorkerNode;
  graphContext: GraphContext;
  incoming: EdgeContract[];
  assembledPrompt: string;
}

export type ProgressCb = (pct: number, note?: string) => void;

export interface RunOutput {
  summary: string;
  results: string[];
  commands: string[];
  artifacts: string[];
  simulated?: boolean;
}

export interface Executor {
  id: Provider;
  available(): boolean;
  run(input: RunInput, cb: ProgressCb): Promise<RunOutput>;
}
