export type NodeStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'rework'
  | 'needs_approval';

export type Priority = 'low' | 'normal' | 'high' | 'critical';
export type Provider = 'bob' | 'openai' | 'anthropic' | 'google' | 'mock';

export interface HistoryEntry {
  ts: string;
  provider: Provider;
  model: string;
  status: 'done' | 'failed';
  summary: string;
  durationMs: number;
  simulated?: boolean;
}

export interface WorkerNode {
  id: string;
  graphId: string;
  teamId: string;
  type: 'worker' | 'gate' | 'inbox';
  name: string;
  status: NodeStatus;
  priority: Priority;
  progress: number; // 0-100
  prompt: {
    task: string;
    refinements: { ts: string; author: string; text: string }[];
    comments: { ts: string; author: string; text: string }[];
  };
  executor: {
    provider: Provider;
    model: string;
    skills: string[];
    tools: string[];
    maxIterations: number;
  };
  context: {
    files: { path: string; kind: 'glob' | 'file' }[];
    extra: string;
  };
  owners: {
    author: string;
    responsible: string[];
  };
  inputs: { fromNodeId: string; enabled: boolean }[];
  output: {
    summary: string;
    results: string[];
    commands: string[];
    artifacts: string[];
  };
  /** Inbox cross-team metadata */
  inboxMeta?: {
    sourceNodeId: string;
    sourceTeamId: string;
    message: string;
  };
  history: HistoryEntry[];
  templateId?: string;
  version: number;
  // canvas position (within team space)
  position: { x: number; y: number };
}

export interface Team {
  id: string;
  name: string;
  parentId: string | null;
  space: { x: number; y: number; w: number; h: number };
  currentTaskLabel?: string;
}

export interface GraphContext {
  id: string;
  teamId: string;
  goal: string;
  repo: string;
  conventions: string;
}

export interface EdgeContract {
  summary_prev: string;
  results: string[];
  commands: string[];
  artifacts: string[];
}

export interface NodeTemplate {
  id: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  defaults: Partial<
    Pick<WorkerNode, 'type' | 'prompt' | 'executor' | 'context' | 'priority'>
  >;
}

export interface Project {
  version: number;
  teams: Team[];
  nodes: WorkerNode[];
  graphContexts: GraphContext[];
  templates: NodeTemplate[];
}
