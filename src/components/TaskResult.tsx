import React from 'react';
import type { WorkerNode } from '../types';
import type { IncomingEdge } from '../prompt';
import { outputPresentation, type OutputAttempt } from '../output-presentation';

export interface ResultAttempt extends OutputAttempt {
  incoming?: IncomingEdge[];
  error?: string;
}

function OutputContent({ output }: { output: WorkerNode['output'] }) {
  return <div className="space-y-2">
    <pre className="whitespace-pre-wrap break-words bg-card border border-line rounded-lg p-2 text-xs">{output.summary || 'No output yet'}</pre>
    {output.results.map((value, i) => <p className="break-words" key={i}>{value}</p>)}
    {output.artifacts.map((value, i) => <p className="text-accent break-words" key={i}>{value}</p>)}
    {output.commands.length > 0 && <pre className="whitespace-pre-wrap break-words bg-card border border-line rounded-lg p-2 text-xs">{output.commands.join('\n')}</pre>}
  </div>;
}

export default function TaskResult({ node, attempts }: { node: WorkerNode; attempts: ResultAttempt[] }) {
  const current = attempts.find(attempt => attempt.nodeId === node.id && attempt.id === node.currentAttemptId);
  const waitingGate = node.type === 'gate' && node.status === 'needs_approval';
  const retained = outputPresentation(node, attempts);
  return <>
    {current?.error && <p role="alert" className="text-err whitespace-pre-wrap break-words">{current.error}</p>}
    {waitingGate && <section aria-label="Frozen review inputs" className="space-y-3">
      <h3 className="font-semibold">Inputs awaiting review</h3>
      <p className="text-muted break-all">Frozen for attempt {node.currentAttemptId ?? 'not recorded'}</p>
      {!current ? <p role="status">Loading review inputs…</p> : !current.incoming ? <p>Input snapshots were not recorded for this attempt.</p> : current.incoming.length === 0 ? <p>No incoming artifacts for this review.</p> :
        current.incoming.map((input, i) => <div key={i} className="space-y-2 border-t border-line pt-3">
          <p className="text-muted break-all">Source {input.fromNodeId} · attempt {input.attemptId ?? 'not recorded'}</p>
          <OutputContent output={input.output ?? input} />
        </div>)}
    </section>}
    {(!waitingGate || retained.retained) && <section aria-label={retained.retained ? 'Retained result' : 'Task output'} className="space-y-2">
      {retained.label && <p className="text-warn break-words">{retained.label}</p>}
      <OutputContent output={node.output} />
    </section>}
  </>;
}
