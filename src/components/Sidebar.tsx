import { useState } from 'react';
import {
  useStore,
  sessionRequest,
  sessionGeneration,
  requireSession,
  acceptCreatedGraph,
} from '../store';
import { ancestors, visibleHierarchyChildren } from '../client-helpers';
import type { GraphContext, WorkspaceBinding } from '../types';
import WorkspaceEditor from './WorkspaceEditor';

/** Modal for creating a new project — separate from the existing project's settings. */
function NewProjectModal({
  teamId,
  onClose,
}: {
  teamId: string;
  onClose: () => void;
}) {
  const state = useStore();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState<WorkspaceBinding>();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting) return; // submission lock — no double-click
    setSubmitting(true);
    setError('');
    const generation = sessionGeneration();
    const form = e.currentTarget;
    const fd = Object.fromEntries(new FormData(form)) as Record<string, string>;
    const { name, goal } = fd;

    if (!newWorkspace) {
      setError('Select and apply a Git workspace first');
      setSubmitting(false);
      return;
    }
    const { path: wsPath, branch: wsBranch, ref: wsRef } = newWorkspace;
    const hasWorkspace = !!(wsPath?.trim() && wsBranch?.trim());

    if (hasWorkspace) {
      try {
        const validateBody: Record<string, string> = {
          path: wsPath.trim(),
          branch: wsBranch.trim(),
          ref: wsRef?.trim() || 'HEAD',
        };
        const vRes = await sessionRequest<{ ok: boolean; message?: string }>(
          '/workspace/validate',
          'POST',
          validateBody,
        );
        requireSession(generation);
        if (!vRes.ok) {
          setError(vRes.message ?? 'Workspace validation failed');
          setSubmitting(false);
          return;
        }
      } catch (err) {
        setError((err as Error).message);
        setSubmitting(false);
        return;
      }
    }

    const body: Record<string, unknown> = { name, goal, teamId };
    if (hasWorkspace) {
      body.workspace = {
        path: wsPath.trim(),
        branch: wsBranch.trim(),
        ref: wsRef?.trim() || 'HEAD',
      };
    }
    try {
      const created = await sessionRequest<GraphContext>('/graphs', 'POST', body);
      requireSession(generation);
      acceptCreatedGraph(created);
      await state.refresh();
      requireSession(generation);
      state.selectGraph(created.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-shade" role="dialog" aria-modal="true" aria-label="New project">
      <div className="modal-panel space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex justify-between items-center">
          <h2 className="text-sm font-semibold">New Project</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-ink w-7 h-7 flex items-center justify-center rounded transition-colors"
          >
            ×
          </button>
        </div>
        <form className="space-y-3" onSubmit={handleSubmit}>
          <label className="block">
            Project name
            <input
              name="name"
              className="form-input mt-1"
              required
              placeholder="e.g. Backend refactor"
              autoFocus
            />
          </label>
          <label className="block">
            Goal
            <input name="goal" className="form-input mt-1" placeholder="Describe the project goal" />
          </label>
          <div>
            <div className="text-xs text-muted mb-1">Git workspace (required)</div>
            <WorkspaceEditor
              value={newWorkspace}
              onChange={setNewWorkspace}
              onPendingChange={() => setNewWorkspace(undefined)}
            />
          </div>
          {error && <p className="text-err text-xs">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              className="action-button flex-1"
              disabled={submitting || !newWorkspace}
            >
              {submitting ? 'Creating…' : 'Create project'}
            </button>
            <button type="button" className="small-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function Sidebar() {
  const state = useStore();
  const [collapsed, setCollapsed] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const graph = state.graphContexts.find((g) => g.id === state.selectedGraphId);
  const editable = !!graph && state.canEdit(graph.teamId);
  const trail = ancestors(state.teams, state.navigationId).filter(t => t.kind !== 'organization');
  const parent = trail[trail.length - 2]?.id ?? null;

  if (collapsed) {
    return (
      <aside
        className="bg-panel border-r border-line flex flex-col items-center py-3 shrink-0"
        style={{ width: 40 }}
        aria-label="Sidebar (collapsed)"
      >
        <button
          aria-label="Expand sidebar"
          onClick={() => setCollapsed(false)}
          className="text-muted hover:text-ink transition-colors p-1 rounded"
          title="Expand sidebar"
        >
          ▶
        </button>
      </aside>
    );
  }

  return (
    <>
      <aside className="w-64 bg-panel border-r border-line p-4 flex flex-col gap-3 overflow-y-auto shrink-0 text-xs">
        {/* Collapse button */}
        <div className="flex justify-end">
          <button
            aria-label="Collapse sidebar"
            onClick={() => setCollapsed(true)}
            className="text-muted hover:text-ink transition-colors p-1 rounded"
            title="Collapse sidebar"
          >
            ◀
          </button>
        </div>

        <div className="flex flex-wrap gap-1">
          <button className="text-accent" onClick={() => state.navigate(null)}>
            {state.auth?.organization.name ?? 'Workspace'}
          </button>
          {trail.map((t) => (
            <span key={t.id}>
              {' '}
              / <button onClick={() => state.navigate(t.id)}>{t.name}</button>
            </span>
          ))}
        </div>
        {state.navigationId && (
          <button
            className="small-button text-left"
            onClick={() => state.navigate(parent)}
          >
            ← Back to parent
          </button>
        )}
        <h2 className="text-muted uppercase text-[10px] tracking-widest">
          {state.selectedTeamId ? 'Team projects' : 'Departments & teams'}
        </h2>
        {!state.selectedTeamId &&
          visibleHierarchyChildren(state.teams, state.navigationId)
            .map((t) => (
              <button
                className="small-button text-left"
                key={t.id}
                onClick={() => state.navigate(t.id)}
              >
                {t.kind === 'department' ? '◇' : '▣'} {t.name}
              </button>
            ))}
        {state.selectedTeamId && (
          <>
            <select
              aria-label="Project"
              className="form-input"
              value={state.selectedGraphId ?? ''}
              onChange={(e) => {
                // Close settings when switching projects to avoid leaking open state
                setSettingsOpen(false);
                state.selectGraph(e.target.value);
              }}
            >
              {state.graphContexts
                .filter((g) => g.teamId === state.selectedTeamId)
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name ?? 'Default project'}
                  </option>
                ))}
            </select>
            {state.canEdit(state.selectedTeamId) && (
              <button
                className="text-accent text-left"
                onClick={() => setShowNewProject(true)}
              >
                + New Project
              </button>
            )}

            {/* Project settings — collapsed section, not permanently shown */}
            {graph && (
              <div className="border border-line rounded-lg overflow-hidden">
                <button
                  type="button"
                  className="w-full flex justify-between items-center px-3 py-2 text-xs text-muted hover:text-ink transition-colors"
                  aria-expanded={settingsOpen}
                  onClick={() => setSettingsOpen((v) => !v)}
                >
                  <span>Project settings</span>
                  <span>{settingsOpen ? '▲' : '▼'}</span>
                </button>
                {settingsOpen && (
                  <fieldset disabled={!editable} className="p-3 space-y-3 border-t border-line">
                    <label>
                      Shared goal
                      <textarea
                        className="form-input mt-1"
                        value={graph.goal}
                        onChange={(e) =>
                          state.updateGraph(graph.id, { goal: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Repository label
                      <input
                        className="form-input mt-1"
                        value={graph.repo}
                        onChange={(e) =>
                          state.updateGraph(graph.id, { repo: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Conventions
                      <textarea
                        className="form-input mt-1"
                        value={graph.conventions}
                        onChange={(e) =>
                          state.updateGraph(graph.id, { conventions: e.target.value })
                        }
                      />
                    </label>
                    <WorkspaceEditor
                      key={graph.id}
                      value={graph.workspace}
                      onChange={(workspace) =>
                        state.updateGraph(graph.id, { workspace })
                      }
                    />
                  </fieldset>
                )}
              </div>
            )}
          </>
        )}
        {!state.teams.length && (
          <p className="text-muted">
            No teams yet. An administrator can add departments, teams and members
            with Manage.
          </p>
        )}
      </aside>

      {showNewProject && state.selectedTeamId && (
        <NewProjectModal
          teamId={state.selectedTeamId}
          onClose={() => setShowNewProject(false)}
        />
      )}
    </>
  );
}
