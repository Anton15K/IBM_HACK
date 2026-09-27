import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { requireSession, sessionGeneration, sessionRequest, useStore } from '../store';
import type { RunMonitorItem, RunMonitorResponse } from '../types';

const statusLabel = (status: string) => status.replace(/_/g, ' ');
export default function RunMonitor({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<RunMonitorResponse | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [canceling, setCanceling] = useState<string | null>(null);
  const mounted = useRef(false);
  const reload = useRef<(() => Promise<void>) | null>(null);
  const cancellation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let pending: Promise<void> | null = null;
    const generation = sessionGeneration();
    const poll = (): Promise<void> => {
      if (pending) return pending;
      pending = (async () => {
        try {
          requireSession(generation);
          const next = await sessionRequest<RunMonitorResponse>('/run-monitor');
          requireSession(generation);
          if (alive) { setData(next); setPollError(''); }
        } catch (err) {
          if (alive && generation === sessionGeneration()) setPollError((err as Error).message);
        } finally {
          pending = null;
          if (alive) { clearTimeout(timer); timer = setTimeout(() => void poll(), 1500); }
        }
      })();
      return pending;
    };
    reload.current = async () => { if (pending) await pending; if (alive) await poll(); };
    void poll();
    return () => { alive = false; mounted.current = false; clearTimeout(timer); reload.current = null; };
  }, []);

  const cancel = async (item: RunMonitorItem) => {
    if (cancellation.current) return;
    cancellation.current = true;
    setCanceling(item.id);
    setError('');
    const generation = sessionGeneration();
    try {
      const path = item.kind === 'graph' ? `/graphs/${item.graphId}/run/cancel` : `/nodes/${item.nodeId}/cancel`;
      await sessionRequest(path, 'POST', item.kind === 'graph' ? { runId: item.id } : { attemptId: item.id });
      requireSession(generation);
      await useStore.getState().refresh();
      requireSession(generation);
      await reload.current?.();
    } catch (err) {
      if (mounted.current && generation === sessionGeneration()) setError((err as Error).message);
    } finally {
      cancellation.current = false;
      if (mounted.current && generation === sessionGeneration()) setCanceling(null);
    }
  };
  const open = async (item: RunMonitorItem) => {
    const generation = sessionGeneration();
    try {
      await useStore.getState().refresh();
      requireSession(generation);
      if (!mounted.current) return;
      const state = useStore.getState();
      if (!state.graphContexts.some(g => g.id === item.graphId && g.teamId === item.teamId)) {
        setError('This project is no longer available.');
        return;
      }
      state.navigate(item.teamId);
      state.selectGraph(item.graphId);
      if (item.nodeId) state.selectNode(item.nodeId);
      onClose();
    } catch (err) {
      if (mounted.current && generation === sessionGeneration()) setError((err as Error).message);
    }
  };
  return (
    <Modal labelledBy="run-monitor-title" describedBy="run-monitor-help" busy={!!canceling} onClose={onClose}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="run-monitor-title" className="text-xl font-semibold">Runs & queue</h2>
        <button className="small-button" aria-label="Close run monitor" disabled={!!canceling} onClick={onClose}>×</button>
      </div>
      <p id="run-monitor-help" className="text-muted text-xs">
        Shared runs for teams you can access. Active work appears first; this view refreshes every 1.5 seconds.
        Cancel stops execution but does not undo file changes.
      </p>
      {error && <p role="alert" className="text-err text-xs">{error}</p>}
      {pollError && <p role="alert" className="text-err text-xs">Could not refresh runs: {pollError}</p>}
      {!data && !error && !pollError && <p role="status" className="text-muted text-sm">Loading runs…</p>}
      {data?.items.length === 0 && <p className="text-muted text-sm">No runs yet. Run a task or project to see it here.</p>}
      {data && <p className="text-muted text-xs">Showing {data.items.length} of {data.total} runs (up to 50).</p>}
      <div className="space-y-3">
        {data?.items.map(item => (
          <article key={`${item.kind}:${item.id}`} className="bg-card border border-line rounded-xl p-3 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-medium text-sm break-words">{item.name}</h3>
                <p className="text-muted text-xs break-words">{item.teamName} · {item.graphName} · {item.kind === 'graph' ? 'Project run' : 'Task run'}</p>
              </div>
              <span className={`text-xs whitespace-nowrap ${item.active ? 'text-accent' : 'text-muted'}`}>{statusLabel(item.status)}</span>
            </div>
            <p className="text-xs">Started by {item.initiator?.name || 'Unknown / not recorded'}</p>
            <p className="text-muted text-xs">
              <time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString()}</time>
              {item.finishedAt && !item.active && <> · Finished <time dateTime={item.finishedAt}>{new Date(item.finishedAt).toLocaleString()}</time></>}
            </p>
            {item.reason && <p className="text-xs break-words">{item.reason}</p>}
            {item.tasks && item.tasks.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted">Tasks ({item.taskCount})</summary>
                <ul className="mt-2 space-y-2">
                  {item.tasks.map(task => <li key={task.id} className="border-l border-line pl-2">
                    <span className="break-words">{task.name}</span> · <span className="text-muted">{statusLabel(task.status)}</span>
                    {task.reason && <p className="text-muted break-words">{task.reason}</p>}
                  </li>)}
                </ul>
                {(item.taskCount ?? 0) > item.tasks.length && <p className="text-muted mt-2">Showing the first {item.tasks.length} tasks. Open the project for the full board.</p>}
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              <button className="small-button" disabled={!!canceling} onClick={() => void open(item)}>{item.nodeId ? 'Open task' : 'Open project'}</button>
              {item.canCancel && <button className="small-button text-err" disabled={!!canceling} onClick={() => void cancel(item)}>
                {canceling === item.id ? 'Canceling…' : item.kind === 'graph' ? 'Cancel project run' : 'Cancel task'}
              </button>}
            </div>
          </article>
        ))}
      </div>
    </Modal>
  );
}
