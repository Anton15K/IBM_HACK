import { useEffect, useState } from 'react';
import { useStore, sessionRequest, sessionGeneration, requireSession, flushEdits } from '../store';
import type { ApiTokenUsage } from '../types';
interface Connection { id: string; label: string; model: string }
interface Proposal {
  plan: { nodes: { id: string; name: string; task: string; output: string; dependsOn: string[] }[] };
  revision: number; model: string; usage?: ApiTokenUsage;
}
export default function PlannerModal({ graphId, close }: { graphId: string; close: () => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [intent, setIntent] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    sessionRequest<{ connections: Connection[] }>('/model-connections').then(r => {
      if (!disposed) { setConnections(r.connections); setConnectionId(r.connections[0]?.id ?? ''); }
    }).catch(e => { if (!disposed) setError(e.message); });
    return () => { disposed = true; };
  }, []);
  const checkContext = (generation: number) => {
    requireSession(generation);
    if (useStore.getState().selectedGraphId !== graphId) throw new Error('Project changed; reopen planner');
  };
  async function generate() {
    if (busy) return;
    const generation = sessionGeneration(); setBusy(true); setError(''); setProposal(null);
    try {
      await flushEdits(); checkContext(generation);
      const result = await sessionRequest<Proposal>(`/graphs/${graphId}/plan`, 'POST', { connectionId, intent });
      checkContext(generation); setProposal(result);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (busy || !proposal) return;
    const generation = sessionGeneration(); setBusy(true); setError('');
    try {
      await flushEdits(); checkContext(generation);
      await sessionRequest(`/graphs/${graphId}/apply-plan`, 'POST', { connectionId, expectedRevision: proposal.revision, plan: proposal.plan });
      checkContext(generation); await useStore.getState().refresh(); close();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="modal-shade" onClick={() => { if (!busy) close(); }}>
    <div className="modal-panel space-y-3 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
      <div className="flex justify-between"><h2 className="font-semibold">Plan project tasks</h2><button disabled={busy} onClick={close}>×</button></div>
      <p className="text-muted text-xs">The model proposes tasks. Apply adds drafts to this project; execution is a separate action.</p>
      <select aria-label="Planning model" className="form-input" disabled={busy} value={connectionId} onChange={e => { setConnectionId(e.target.value); setProposal(null); }}>
        <option value="">Select an API connection</option>
        {connections.map(c => <option key={c.id} value={c.id}>{c.label} · {c.model}</option>)}
      </select>
      {!connections.length && <p className="text-warn text-xs">Add an API model connection in Backend settings.</p>}
      <textarea aria-label="What should the project achieve?" className="form-input" rows={4} maxLength={8000} disabled={busy} placeholder="What should this project achieve?" value={intent} onChange={e => { setIntent(e.target.value); setProposal(null); }} />
      <button className="action-button" disabled={busy || !connectionId || !intent.trim()} onClick={() => void generate()}>{busy ? 'Working…' : 'Generate plan'}</button>
      {error && <p className="text-err text-xs" role="alert">{error}</p>}
      {proposal && <>
        <p className="text-muted text-xs">{proposal.model} · {proposal.usage ? `${proposal.usage.totalTokens} API tokens` : 'Usage not reported'}</p>
        {proposal.plan.nodes.map(n => <div key={n.id} className="bg-card border border-line rounded-lg p-3 text-xs space-y-1">
          <p className="font-medium">{n.name} · {n.output}</p><p className="whitespace-pre-wrap">{n.task}</p><p className="text-muted">After: {n.dependsOn.join(', ') || 'Start'}</p>
        </div>)}
        <div className="flex gap-2"><button className="action-button" disabled={busy} onClick={() => void apply()}>Apply plan</button><button className="small-button" disabled={busy} onClick={() => setProposal(null)}>Discard</button></div>
      </>}
    </div>
  </div>;
}
