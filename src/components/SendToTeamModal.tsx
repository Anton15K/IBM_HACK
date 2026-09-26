import { useState } from 'react';
import { useStore } from '../store';
import type { WorkerNode, Priority } from '../types';

interface Props {
  node: WorkerNode;
  onClose: () => void;
}

function makeId() {
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function SendToTeamModal({ node, onClose }: Props) {
  const teams = useStore((s) => s.teams);
  const nodes = useStore((s) => s.nodes);
  const addNode = useStore((s) => s.addNode);

  // Only leaf teams (those that have a space with w > 0) and not own team
  const targetTeams = teams.filter(
    (t) => t.id !== node.teamId && t.space.w > 0
  );

  const [targetTeamId, setTargetTeamId] = useState(targetTeams[0]?.id ?? '');
  const [message, setMessage] = useState('');
  const [escalate, setEscalate] = useState(node.priority === 'critical');

  const handleSend = () => {
    if (!targetTeamId) return;

    const targetTeam = teams.find((t) => t.id === targetTeamId);
    if (!targetTeam) return;

    const graphId = `graph-${targetTeamId}`;

    // Find first existing node in that team to place inbox node near it
    const teamNodes = nodes.filter((n) => n.teamId === targetTeamId);
    const lastNode = teamNodes[teamNodes.length - 1];
    const posX = lastNode ? lastNode.position.x + 320 : 60;
    const posY = lastNode ? lastNode.position.y : 160;

    const inboxNode: WorkerNode = {
      id: makeId(),
      graphId,
      teamId: targetTeamId,
      type: 'inbox',
      name: `From ${teams.find((t) => t.id === node.teamId)?.name ?? 'Unknown'}: ${node.name}`,
      status: 'draft',
      priority: escalate ? 'critical' : (node.priority as Priority),
      progress: 0,
      position: { x: posX, y: posY },
      prompt: {
        task: `[Cross-team request from ${node.owners.author}]\n\n${node.prompt.task}${message ? `\n\nMessage: ${message}` : ''}`,
        refinements: [],
        comments: [],
      },
      executor: {
        provider: 'mock',
        model: 'mock-v1',
        skills: [],
        tools: [],
        maxIterations: 3,
      },
      context: {
        files: [],
        extra: `Source node: ${node.name} (id: ${node.id}) from team ${teams.find((t) => t.id === node.teamId)?.name}`,
      },
      owners: {
        author: node.owners.author,
        responsible: [],
      },
      inputs: [],
      output: { summary: '', results: [], commands: [], artifacts: [] },
      inboxMeta: {
        sourceNodeId: node.id,
        sourceTeamId: node.teamId,
        message,
      },
      history: [],
      version: 1,
    };

    addNode(inboxNode);
    onClose();

    // Toast via window (simple approach, no extra deps)
    const teamName = targetTeam.name;
    const toast = document.createElement('div');
    toast.textContent = `✓ Sent to ${teamName}`;
    toast.style.cssText = `
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: #1A2235; border: 1px solid #34D399; color: #34D399;
      padding: 8px 20px; border-radius: 10px; font-size: 13px; font-weight: 600;
      z-index: 9999; pointer-events: none;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  };

  if (targetTeams.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="relative bg-panel border border-line rounded-[20px] w-96 p-6 shadow-panel z-10">
          <div className="text-ink text-sm font-semibold mb-2">Send to Team</div>
          <p className="text-muted text-xs">No other teams available in this project.</p>
          <button
            onClick={onClose}
            className="mt-4 w-full py-1.5 rounded-lg text-xs bg-card border border-line text-muted hover:text-ink transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-panel border border-line rounded-[20px] w-[440px] shadow-panel z-10">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <span className="text-ink font-semibold">Send to Team…</span>
          <button onClick={onClose} className="text-muted hover:text-ink">×</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Source info */}
          <div className="bg-card border border-line rounded-lg p-3">
            <div className="text-muted text-[10px] mb-1">Sending node</div>
            <div className="text-ink text-xs font-medium">{node.name}</div>
            <div className="text-muted text-[10px] mt-0.5">
              {teams.find((t) => t.id === node.teamId)?.name ?? node.teamId}
            </div>
          </div>

          {/* Target team */}
          <div>
            <label className="text-muted text-[10px] block mb-1">Target Team</label>
            <select
              value={targetTeamId}
              onChange={(e) => setTargetTeamId(e.target.value)}
              className="w-full bg-card border border-line rounded-lg px-2.5 py-1.5 text-ink text-xs outline-none focus:border-accent"
            >
              {targetTeams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          {/* Message */}
          <div>
            <label className="text-muted text-[10px] block mb-1">Message (optional)</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="Context or instructions for the receiving team…"
              className="w-full bg-card border border-line rounded-lg px-2.5 py-1.5 text-ink text-xs outline-none focus:border-accent resize-none placeholder-muted/50"
            />
          </div>

          {/* Priority escalation */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={escalate}
              onChange={(e) => setEscalate(e.target.checked)}
              className="rounded"
            />
            <span className="text-ink text-xs">
              Escalate priority to <span className="text-err font-semibold">critical</span>
            </span>
            {node.priority === 'critical' && (
              <span className="text-muted text-[10px]">(source is already critical)</span>
            )}
          </label>
        </div>

        <div className="px-5 py-3 border-t border-line flex gap-2">
          <button
            onClick={handleSend}
            disabled={!targetTeamId}
            className="flex-1 py-1.5 rounded-lg text-xs font-semibold bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 transition-colors border border-accent/30"
          >
            📤 Send
          </button>
          <button
            onClick={onClose}
            className="py-1.5 px-4 rounded-lg text-xs bg-card border border-line text-muted hover:text-ink transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
