import { useEffect, useRef, useState } from 'react';
import type { WorkerNode, Team, Priority } from '../types';
import {
  flushEdits,
  sessionRequest,
  sessionGeneration,
  requireSession,
  useStore,
} from '../store';
import { handoffBody } from '../client-helpers';
export default function SendToTeamModal({
  node,
  onClose,
}: {
  node: WorkerNode;
  onClose: () => void;
}) {
  const [teams, setTeams] = useState<Pick<Team, 'id' | 'name' | 'kind'>[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{
    recipientNodeId: string;
    recipientTeamId: string;
  } | null>(null);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    let alive = true;
    void sessionRequest<Team[]>('/team-directory')
      .then((data) => {
        if (alive)
          setTeams(
            data.filter((t) => t.id !== node.teamId && t.kind === 'team'),
          );
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [node.teamId]);
  return (
    <div className="modal-shade">
      <form
        className="modal-panel space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const generation = sessionGeneration();
          setBusy(true);
          setError('');
          const data = Object.fromEntries(new FormData(e.currentTarget));
          try {
            await flushEdits();
            requireSession(generation);
            const source =
              useStore.getState().nodes.find((n) => n.id === node.id) ?? node;
            setReceipt(
              await sessionRequest(
                `/nodes/${node.id}/handoff`,
                'POST',
                handoffBody(
                  source,
                  String(data.targetTeamId),
                  String(data.message),
                  requestId.current,
                  data.priority as Priority,
                ),
              ),
            );
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex justify-between">
          <h2 className="font-semibold">Send request to team</h2>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>
        {receipt ? (
          <>
            <p className="text-ok">Request delivered.</p>
            <p className="text-muted text-xs">
              Recipient task: {receipt.recipientNodeId}
            </p>
            {useStore
              .getState()
              .graphContexts.some(
                (g) => g.teamId === receipt.recipientTeamId,
              ) && (
              <button
                type="button"
                className="action-button"
                onClick={() => {
                  useStore.getState().navigate(receipt.recipientTeamId);
                  onClose();
                }}
              >
                Open recipient team
              </button>
            )}
          </>
        ) : (
          <fieldset disabled={busy} className="space-y-3">
            <select name="targetTeamId" required className="form-input">
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <textarea
              name="message"
              required
              className="form-input"
              placeholder="Request and expected result"
            />
            <select
              name="priority"
              defaultValue={node.priority}
              className="form-input"
            >
              {['low', 'normal', 'high', 'critical'].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <button className="action-button" disabled={!teams.length}>
              Send request
            </button>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="text-err text-xs">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
