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
export type Provider = 'bob' | 'openai' | 'anthropic' | 'google' | 'mock' | 'api';

export interface HistoryEntry {
  ts: string;
  provider: Provider;
  model: string;
  status: 'done' | 'failed';
  summary: string;
  durationMs: number;
  simulated?: boolean;
  /** Attempt identifier for this run (set by executor) */
  attemptId?: string;
  /** Upstream task id returned by the provider (e.g. Bob task_id) */
  taskId?: string | null;
  /** Aggregated session cost in Bobcoins returned by the provider */
  sessionCosts?: number | null;
  /** Workspace fingerprint captured before execution */
  workspaceBefore?: string;
  /** Workspace fingerprint captured after execution */
  workspaceAfter?: string;
  /** Token usage from API provider */
  apiUsage?: ApiTokenUsage;
}

/**
 * Git workspace binding.  Stored on GraphContext (org-wide default) and
 * optionally overridden per WorkerNode.  All three fields must be non-empty
 * strings.  ref describes the desired Git version (HEAD / branch / tag /
 * commit SHA); the executor resolves / verifies it at runtime.
 */
export interface WorkspaceBinding {
  path: string;   // absolute path to the local clone
  branch: string; // branch name
  ref: string;    // HEAD | branch | tag | commit SHA
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
    /** Maximum cost budget for this node (0 < maxCost <= 3; default 0.5) */
    maxCost?: number;
    /** Maximum execution attempts (integer 1–10; default 3) */
    maxAttempts?: number;
    /** API model connection id (required when provider='api') */
    connectionId?: string;
    /** Maximum output tokens for API provider (64–65536; default 1024) */
    maxOutputTokens?: number;
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
    sourceAttemptId?: string;
    sourceOutput?: WorkerNode['output'];
    message: string;
  };
  history: HistoryEntry[];
  currentAttemptId?: string;
  templateId?: string;
  /** Desired output mode for the runner (set at authoring time) */
  desiredOutput?: 'report' | 'patch' | 'commit' | 'pull_request';
  /**
   * Per-node Git workspace binding.  When present, overrides the graph-level
   * binding for this node only.  PATCH null clears the override (node reverts
   * to inheriting the graph binding).
   */
  workspace?: WorkspaceBinding;
  version: number;
  // canvas position (within team space)
  position: { x: number; y: number };
}

/**
 * A point-in-time snapshot of a Git workspace, captured by the executor
 * before/after a task run.  Proves the observed state; does NOT claim full
 * reconstructibility of untracked file contents.
 */
export interface WorkspaceSnapshot {
  /** Absolute path to the binding directory (may be a subfolder of the worktree) */
  path: string;
  /** Absolute path to the Git worktree root (output of git rev-parse --show-toplevel) */
  repositoryPath: string;
  branch: string;
  requestedRef: string;
  /** Resolved commit SHA at HEAD */
  commitSha: string;
  /** True when the index or working tree has uncommitted changes */
  dirty: boolean;
  /**
   * Stable fingerprint string incorporating the commit SHA, dirty flag,
   * binary diff bytes, and content hashes of untracked files.
   * Does NOT solely rely on git status output.
   */
  fingerprint: string;
  /**
   * Binary git diff (git diff HEAD --binary) as a base64 string.
   * Empty string when the working tree is clean.
   * Bounded – capture fails explicitly when the diff exceeds the size cap.
   */
  trackedDiff: string;
  /** Non-ignored untracked files with their content SHA-256 hashes */
  untracked: { path: string; sha256: string }[];
}

/** Identity fields for a single execution attempt */
export interface AttemptIdentity {
  attemptId: string;
  nodeId: string;
  nodeVersion: number;
  graphId: string;
  ts: string;
}

/** Token usage from an API provider call */
export interface ApiTokenUsage {
  /** At least one upstream response omitted usage; totals cover only known calls. */
  incomplete?: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Lightweight metadata attached to a completed or failed attempt */
export interface AttemptMeta {
  provider: Provider;
  model: string;
  durationMs: number;
  status: 'done' | 'failed';
  simulated: boolean;
  /** Provider task id (null when unknown) */
  taskId: string | null;
  /** Aggregated session cost in Bobcoins (null when unknown) */
  sessionCosts: number | null;
  workspaceBefore?: string;
  workspaceAfter?: string;
  /** Token usage from API provider (undefined when not applicable) */
  apiUsage?: ApiTokenUsage;
}

export interface Team {
  id: string;
  name: string;
  parentId: string | null;
  space: { x: number; y: number; w: number; h: number };
  currentTaskLabel?: string;
  /** Structural kind – set at creation, immutable after that */
  kind?: 'organization' | 'department' | 'team';
}

export interface GraphContext {
  id: string;
  name?: string;
  teamId: string;
  goal: string;
  /** Descriptive repository identifier (e.g. "org/repo" or a URL).
   *  This is a label only – the executor uses workspace.path for the
   *  actual checkout location. */
  repo: string;
  conventions: string;
  /**
   * Organisation-wide Git workspace binding for this graph.
   * Individual nodes may override this with their own workspace field.
   */
  workspace?: WorkspaceBinding;
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
    Pick<WorkerNode, 'type' | 'prompt' | 'executor' | 'context' | 'priority' | 'desiredOutput'>
  >;
}

export interface Project {
  version: number;
  teams: Team[];
  nodes: WorkerNode[];
  graphContexts: GraphContext[];
  templates: NodeTemplate[];
}


/** Server-recorded identity at launch time; absent on older history. */
export interface ExecutionInitiator {
  id: string;
  name: string;
}

export interface RunMonitorTask {
  id: string;
  name: string;
  status: string;
  reason: string;
}

export interface RunMonitorItem {
  id: string;
  kind: 'graph' | 'attempt';
  teamId: string;
  teamName: string;
  graphId: string;
  graphName: string;
  nodeId?: string;
  name: string;
  status: string;
  active: boolean;
  reason: string;
  initiator?: ExecutionInitiator;
  startedAt: string;
  finishedAt?: string;
  canCancel: boolean;
  tasks?: RunMonitorTask[];
  taskCount?: number;
}

export interface RunMonitorResponse {
  items: RunMonitorItem[];
  total: number;
}
