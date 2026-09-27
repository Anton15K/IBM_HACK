import { useState } from 'react';
import { useStore, sessionGeneration } from '../store';
import { ancestors, visibleHierarchyChildren } from '../client-helpers';
import WorkspaceEditor from './WorkspaceEditor';
import NewProjectDialog from './NewProjectDialog';

export default function Sidebar() {
  const state = useStore();
  const [collapsed, setCollapsed] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const graph = state.graphContexts.find((g) => g.id === state.selectedGraphId);
  const editable = !!graph && state.canEdit(graph.teamId);
  const trail = ancestors(state.teams, state.navigationId).filter(t => t.kind !== 'organization');
  const parent = trail[trail.length - 2]?.id ?? null;

  return (
    <>
      <aside className={`bg-panel border-r border-line overflow-y-auto shrink-0 text-xs ${collapsed ? 'w-10 p-2' : 'w-64 p-4'}`}
        aria-label={collapsed ? 'Sidebar (collapsed)' : 'Sidebar'}>
        {/* Collapse button */}
        <div className="flex justify-end">
          <button
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed(value => !value)}
            className="text-muted hover:text-ink transition-colors p-1 rounded"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '▶' : '◀'}
          </button>
        </div>

        <div hidden={collapsed}>
        <div className="flex flex-col gap-3 mt-3">
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
                <div hidden={!settingsOpen}>
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
                      key={`${sessionGeneration()}:${graph.id}`}
                      value={graph.workspace}
                      onChange={(workspace) =>
                        state.updateGraph(graph.id, { workspace })
                      }
                    />
                  </fieldset>
                </div>
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
        </div>
        </div>
      </aside>

      {showNewProject && state.selectedTeamId && (
        <NewProjectDialog
          key={`${sessionGeneration()}:${state.selectedTeamId}`}
          teamId={state.selectedTeamId}
          onClose={() => setShowNewProject(false)}
        />
      )}
    </>
  );
}
