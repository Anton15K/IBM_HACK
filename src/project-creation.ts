import { acceptCreatedGraph, requireSession, sessionRequest, useStore } from './store';
import type { GraphContext, WorkspaceBinding } from './types';

export type ProjectSource =
  | { kind: 'existing'; workspace: WorkspaceBinding }
  | { kind: 'init' | 'clone'; parentPath: string; name: string; url?: string };

type Validation =
  | { ok: true; path: string; branch: string }
  | { ok: false; message: string };

export async function createProject(
  input: { teamId: string; name: string; goal: string; source: ProjectSource },
  generation: number,
  prepared: WorkspaceBinding | undefined,
  onPrepared: (workspace: WorkspaceBinding) => void,
): Promise<void> {
  requireSession(generation);
  const state = useStore.getState();
  if (!state.canEdit(input.teamId)) throw new Error('This team is no longer available for editing.');
  if (!input.name.trim()) throw new Error('Enter a project name.');

  let workspace: WorkspaceBinding;
  if (input.source.kind === 'existing') {
    workspace = input.source.workspace;
  } else {
    if (state.auth?.role !== 'admin') throw new Error('Only admins can prepare a repository. Choose an existing Git folder.');
    workspace = prepared ?? await sessionRequest<WorkspaceBinding>('/workspace/create', 'POST', input.source);
    requireSession(generation);
    // Keep a prepared folder when validation or project creation needs a retry.
    onPrepared(workspace);
  }
  const binding = { path: workspace.path.trim(), branch: workspace.branch.trim(), ref: workspace.ref.trim() || 'HEAD' };
  const result = await sessionRequest<Validation>('/workspace/validate', 'POST', binding);
  requireSession(generation);
  if (!result.ok) throw new Error(result.message || 'Workspace validation failed.');
  const graph = await sessionRequest<GraphContext>('/graphs', 'POST', {
    name: input.name.trim(), goal: input.goal, teamId: input.teamId,
    workspace: { path: result.path, branch: result.branch, ref: binding.ref },
  });
  requireSession(generation);
  acceptCreatedGraph(graph);
  await useStore.getState().refresh();
  requireSession(generation);
  useStore.getState().selectGraph(graph.id);
}
