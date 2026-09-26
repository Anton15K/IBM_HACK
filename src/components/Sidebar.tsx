import { useState } from 'react';
import {
  useStore,
  sessionRequest,
  sessionGeneration,
  requireSession,
  acceptCreatedGraph,
} from '../store';
import { ancestors } from '../client-helpers';
import type { GraphContext } from '../types';
import WorkspaceEditor from './WorkspaceEditor';
export default function Sidebar() {
  const state = useStore();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const graph = state.graphContexts.find((g) => g.id === state.selectedGraphId);
  const editable = !!graph && state.canEdit(graph.teamId);
  const trail = ancestors(state.teams, state.navigationId);
  const parent = trail[trail.length - 2]?.id ?? null;
  return (
    <aside className="w-64 bg-panel border-r border-line p-4 flex flex-col gap-3 overflow-y-auto shrink-0 text-xs">
      <div className="flex flex-wrap gap-1">
        <button className="text-accent" onClick={() => state.navigate(null)}>
          Company
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
        state.teams
          .filter((t) => t.parentId === state.navigationId)
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
            onChange={(e) => state.selectGraph(e.target.value)}
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
              onClick={() => setCreating(!creating)}
            >
              + New Project
            </button>
          )}
          {creating && (
            <form
              className="space-y-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const generation = sessionGeneration();
                setError('');
                const form = e.currentTarget;
                const data = Object.fromEntries(new FormData(form));
                try {
                  const created = await sessionRequest<GraphContext>(
                    '/graphs',
                    'POST',
                    { ...data, teamId: state.selectedTeamId },
                  );
                  requireSession(generation);
                  acceptCreatedGraph(created);
                  await state.refresh();
                  requireSession(generation);
                  state.selectGraph(created.id);
                  setCreating(false);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <input
                name="name"
                className="form-input"
                required
                placeholder="Project name"
              />
              <input name="goal" className="form-input" placeholder="Goal" />
              <button className="action-button">Create Project</button>
              {error && <p className="text-err">{error}</p>}
            </form>
          )}
          {graph && (
            <fieldset disabled={!editable} className="space-y-3">
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
        </>
      )}
      {!state.teams.length && (
        <p className="text-muted">
          No teams yet. An administrator can add departments, teams and members
          with Manage.
        </p>
      )}
    </aside>
  );
}
