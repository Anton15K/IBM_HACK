import { useState } from 'react';
import PlannerModal from './PlannerModal';
import RunMonitor from './RunMonitor';
import { useStore } from '../store';
export default function TopBar() {
  const state = useStore();
  const [planningGraph, setPlanningGraph] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const editable = state.selectedTeamId && state.canEdit(state.selectedTeamId);
  const busy = state.busy.includes(`graph:${state.selectedGraphId}`);
  return (
    <header className="bg-panel border-b border-line min-h-16 px-4 py-3 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 shrink-0 [&>button]:shrink-0 [&>button]:whitespace-nowrap">
      <button
        className="text-ink font-semibold text-lg"
        onClick={() => state.navigate(null)}
      >
        TeamWeave
      </button>
      <span className="text-muted text-xs max-w-40 truncate" title={state.auth?.organization.name}>
        {state.auth?.organization.name}
      </span>
      <div className="flex-1" />
      {showRuns && <RunMonitor onClose={() => setShowRuns(false)} />}
      {planningGraph && planningGraph === state.selectedGraphId && editable && <PlannerModal key={planningGraph} graphId={planningGraph} close={() => setPlanningGraph(null)} />}
      {editable && (
        <>
          <button className="small-button" disabled={!state.selectedGraphId} onClick={() => setPlanningGraph(state.selectedGraphId)}>AI plan</button>
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
      <button className="small-button" onClick={() => setShowRuns(true)}>Runs &amp; queue</button>
      <button className="small-button" onClick={state.toggleSettings}>
        Model settings
      </button>
      {state.auth?.role === 'admin' && (
        <button
          className="small-button"
          onClick={() => useStore.setState({ showAdmin: true })}
        >
          Manage
        </button>
      )}
      <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
        <span className="text-muted text-xs max-w-24 truncate" title={state.auth?.user.name}>{state.auth?.user.name}</span>
        <button className="small-button" onClick={() => void state.logout()}>
          Log out
        </button>
      </div>
    </header>
  );
}
