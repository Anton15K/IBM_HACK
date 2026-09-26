import { useState } from 'react';
import PlannerModal from './PlannerModal';
import { useStore } from '../store';
export default function TopBar() {
  const state = useStore();
  const [planningGraph, setPlanningGraph] = useState<string | null>(null);
  const editable = state.selectedTeamId && state.canEdit(state.selectedTeamId);
  const busy = state.busy.includes(`graph:${state.selectedGraphId}`);
  return (
    <header className="bg-panel border-b border-line h-16 px-5 flex items-center gap-3 shrink-0">
      <button
        className="text-ink font-semibold text-lg"
        onClick={() => state.navigate(null)}
      >
        TeamWeave
      </button>
      <span className="text-muted text-xs">
        {state.auth?.organization.name}
      </span>
      <div className="flex-1" />
      {planningGraph && planningGraph === state.selectedGraphId && editable && <PlannerModal key={planningGraph} graphId={planningGraph} close={() => setPlanningGraph(null)} />}
      {editable && (
        <>
          <button className="small-button" disabled={!state.selectedGraphId} onClick={() => setPlanningGraph(state.selectedGraphId)}>AI plan</button>
          <button
            disabled={
              !state.selectedGraphId || state.busy.includes('createNode')
            }
            className="action-button"
            onClick={() => void state.createNode()}
          >
            + New Task
          </button>
          <button
            className="small-button"
            onClick={() => void state.createNode('gate')}
          >
            + Gate
          </button>
          <button
            className="small-button"
            onClick={state.toggleTemplatesDrawer}
          >
            Templates
          </button>
          <button
            disabled={
              busy ||
              !state.selectedGraphId ||
              ['running', 'waiting'].includes(state.graphRun?.status ?? '')
            }
            className="action-button"
            onClick={() => void state.runGraph()}
          >
            Run pending tasks
          </button>
          {state.graphRun && (
            <>
              <span className="text-muted text-xs">
                {state.graphRun.status}
                {state.graphRun.paused ? ' · paused' : ''}
              </span>
              {state.graphRun.status === 'waiting' && state.graphRun.paused && (
                <button
                  disabled={busy}
                  className="small-button"
                  onClick={() => void state.resumeGraph()}
                >
                  Resume
                </button>
              )}
              {['running', 'waiting'].includes(state.graphRun.status) && (
                <button
                  disabled={busy}
                  className="small-button"
                  onClick={() => void state.cancelGraph()}
                >
                  Cancel
                </button>
              )}
            </>
          )}
        </>
      )}
      <button
        className="small-button"
        onClick={() => {
          const blob = new Blob(
            [JSON.stringify(state.exportProject(), null, 2)],
            { type: 'application/json' },
          );
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'teamweave.json';
          a.click();
          URL.revokeObjectURL(url);
        }}
      >
        Export
      </button>
      <button className="small-button" onClick={state.toggleSettings}>
        Backend
      </button>
      {state.auth?.role === 'admin' && (
        <button
          className="small-button"
          onClick={() => useStore.setState({ showAdmin: true })}
        >
          Manage
        </button>
      )}
      <span className="text-muted text-xs">{state.auth?.user.name}</span>
      <button className="small-button" onClick={() => void state.logout()}>
        Log out
      </button>
    </header>
  );
}
