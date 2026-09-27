import { memo, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import type { WorkerNode } from '../types';
import { statusColor, statusLabel, priorityColor, PROVIDER_LABELS, NODE_TYPE_LABELS } from '../utils/colors';
import { useStore } from '../store';
import { blockedWorkerInputsReady } from '../node-actions';
import SendToTeamModal from './SendToTeamModal';

export type WorkerNodeData = WorkerNode & Record<string, unknown>;
export type WorkerNodeType = Node<WorkerNodeData, 'worker'>;

// Status color is ALWAYS the primary signal. Critical priority = red left stripe only.
export const WorkerNodeCard = memo(function WorkerNodeCard({ data, selected }: NodeProps<WorkerNodeType>) {
  const node = data;
  const runNode = useStore((s) => s.runNode);
  const selectNode = useStore((s) => s.selectNode);
  const approveGate = useStore((s) => s.approveGate);
  const nodes = useStore((s) => s.nodes);
  const teams = useStore((s) => s.teams);
  const canEdit = useStore((s) => s.canEdit);
  const busy = useStore((s) => s.busy.includes(node.id));
  const editable = canEdit(node.teamId);

  const fullNode = nodes.find((n) => n.id === node.id) ?? node;
  const upstreamId = fullNode.inputs[0]?.fromNodeId;

  const [showSendModal, setShowSendModal] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Status drives the color, NOT priority
  const color = statusColor(node.status, 'normal'); // pass 'normal' to strip priority override
  const isCritical = node.priority === 'critical';
  const isRunning = node.status === 'running';
  const isGate = node.type === 'gate';
  const isApproval = node.status === 'needs_approval';
  const isDone = node.status === 'done';
  const isBlocked = node.status === 'blocked';
  const inputsReady = blockedWorkerInputsReady(fullNode, nodes);

  // Selected ring glow
  const selectedShadow = selected
    ? `0 0 0 2px #5B8CFF, 0 0 20px rgba(91,140,255,0.35), 0 4px 20px rgba(0,0,0,0.5)`
    : isRunning
    ? undefined // CSS animation handles the pulse shadow
    : `0 4px 20px rgba(0,0,0,0.5)`;

  const sourceTeamName = node.inboxMeta
    ? teams.find((t) => t.id === node.inboxMeta!.sourceTeamId)?.name
    : null;

  const handleDoubleClick = () => selectNode(node.id);

  const handleRunClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    runNode(node.id);
  };

  const handleApprove = (e: React.MouseEvent) => {
    e.stopPropagation();
    approveGate(node.id);
  };

  const handleRequestChanges = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectNode(node.id);
  };

  // What to render in the fixed footer slot
  type FooterMode = 'approve' | 'run' | 'idle';
  let footerMode: FooterMode = 'idle';
  if (editable && !busy && isApproval && node.currentAttemptId) footerMode = 'approve';
  else if (editable && !busy && !isRunning && node.type !== 'inbox' && node.status !== 'queued' && !isDone && (!isBlocked || inputsReady)) footerMode = 'run';

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = () => setContextMenu(null);

  return (
    <>
    <div
      className={`relative bg-card rounded-[14px] border-[1.5px] transition-all duration-300 select-none w-[210px] flex flex-col`}
      style={{
        borderColor: selected ? '#5B8CFF' : `${color}66`,
        boxShadow: selectedShadow,
        animation: isRunning && !selected ? 'pulse_run 1.4s ease-in-out infinite' : undefined,
      }}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Critical priority: red left stripe */}
      {isCritical && (
        <div
          className="absolute left-0 top-3 bottom-3 w-[3px] rounded-full"
          style={{ backgroundColor: '#F87171' }}
        />
      )}

      {/* Top status bar */}
      <div className="h-[3px] rounded-t-[13px]" style={{ backgroundColor: color }} />

      {/* Header */}
      <div className="px-3 pt-2.5 pb-0">
        <div className="flex items-start justify-between gap-1 mb-1.5">
          {/* Type badge — 11px, stronger contrast */}
          <span
            className="text-[11px] font-medium px-2 py-0.5 rounded-md leading-tight flex items-center gap-1"
            style={{
              backgroundColor: `${color}30`,
              color,
              border: `1px solid ${color}50`,
            }}
          >
            {node.type === 'inbox' && <span>📥</span>}
            {NODE_TYPE_LABELS[node.type]}
          </span>

          <div className="flex items-center gap-1">
            {/* Critical flag icon */}
            {isCritical && (
              <svg width="10" height="11" viewBox="0 0 10 11" fill="none" aria-label="CRITICAL">
                <title>CRITICAL</title>
                <path d="M5 1L5 6.5" stroke="#F87171" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="5" cy="9" r="1" fill="#F87171" />
              </svg>
            )}
            {/* Priority badge — only show if not critical (critical has the stripe + flag) */}
            {!isCritical && (
              <span
                className="text-[10px] font-medium px-1.5 py-0.5 rounded-md leading-tight uppercase tracking-wide"
                style={{
                  backgroundColor: `${priorityColor(node.priority)}25`,
                  color: priorityColor(node.priority),
                  border: `1px solid ${priorityColor(node.priority)}45`,
                }}
              >
                {node.priority}
              </span>
            )}
          </div>
        </div>

        {/* Name — acts as inspect button; nodrag/nopan so click never starts a drag */}
        <button
          type="button"
          className="nodrag nopan text-ink text-[13px] font-semibold leading-snug line-clamp-2 mb-1 text-left w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent rounded"
          aria-label={`Inspect ${node.name}`}
          onClick={(e) => { e.stopPropagation(); selectNode(node.id); }}
        >
          {node.name}
        </button>

        {/* Source team badge for cross-team inbox */}
        {sourceTeamName && (
          <div className="mb-1.5">
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-md"
              style={{ backgroundColor: '#5B8CFF22', color: '#5B8CFF', border: '1px solid #5B8CFF33' }}
            >
              from: {sourceTeamName}
            </span>
          </div>
        )}

        {/* Provider meta — raised opacity */}
        <div className="flex items-center gap-1 mb-2">
          <span className="text-[11px]" style={{ color: '#B0BAD0' }}>
            {PROVIDER_LABELS[node.executor.provider] ?? node.executor.provider}
          </span>
          {node.executor.model && (
            <span className="text-[11px]" style={{ color: '#7A8499' }}>· {node.executor.model}</span>
          )}
        </div>
      </div>

      {/* Activity / progress — running shows indeterminate; done/rework shows actual progress */}
      {(isRunning || isDone || node.status === 'rework') && (
        <div className="px-3 pb-1.5">
          {isRunning ? (
            /* Indeterminate animated bar — no fabricated percentage */
            <div className="h-1.5 bg-line rounded-full overflow-hidden relative">
              <div className="absolute inset-y-0 rounded-full" style={{
                width: '40%',
                backgroundColor: color,
                animation: 'indeterminate_slide 1.4s ease-in-out infinite',
              }} />
            </div>
          ) : (
            <div className="h-1.5 bg-line rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-200"
                style={{ width: `${node.progress}%`, backgroundColor: color }}
              />
            </div>
          )}
        </div>
      )}

      {/* Status row */}
      <div className="px-3 pb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-[11px] font-medium" style={{ color }}>
            {statusLabel(node.status)}
          </span>
        </div>
        <span className="text-[10px] truncate max-w-[80px]" style={{ color: '#7A8499' }}>
          {node.owners.author.split('@')[0]}
        </span>
      </div>

      {/* ── Fixed-height footer slot: always reserves same space ─────────────── */}
      <div className="px-3 pb-3 mt-auto">
        {footerMode === 'approve' && (
          <div className="flex gap-1.5">
            <button
              onClick={handleApprove}
              className="flex-1 py-1 rounded-md text-[11px] font-semibold transition-colors"
              style={{ backgroundColor: 'rgba(52,211,153,0.18)', color: '#34D399', border: '1px solid rgba(52,211,153,0.3)' }}
            >
              Approve
            </button>
            {upstreamId && (
              <button
                onClick={handleRequestChanges}
                className="flex-1 py-1 rounded-md text-[11px] font-semibold transition-colors"
                style={{ backgroundColor: 'rgba(251,191,36,0.18)', color: '#FBBF24', border: '1px solid rgba(251,191,36,0.3)' }}
              >
                Rework
              </button>
            )}
          </div>
        )}
        {inputsReady && (
          <p className="text-[10px] text-accent mb-1" title="Inputs are complete. The server will recheck dependencies and workspace when you run.">
            Inputs ready · retry available
          </p>
        )}
        {footerMode === 'run' && (
          <button
            onClick={handleRunClick}
            className="w-full py-1 rounded-md text-[11px] font-semibold transition-colors"
            style={{
              backgroundColor: `${color}20`,
              color,
              border: `1px solid ${color}40`,
            }}
          >
            {isGate ? 'Review' : 'Run Node'}
          </button>
        )}
        {footerMode === 'idle' && (
          /* Placeholder preserves height so cards align in a row */
          <div className="h-[26px]" />
        )}
      </div>

      <Handle isConnectable={editable} type="target" position={Position.Left} style={{ top: '50%' }} />
      <Handle isConnectable={editable} type="source" position={Position.Right} style={{ top: '50%' }} />
    </div>

    {/* Right-click context menu */}
    {contextMenu && (
      <>
        <div className="fixed inset-0 z-40" onClick={closeContextMenu} />
        <div
          className="fixed z-50 bg-panel border border-line rounded-xl shadow-panel py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => { closeContextMenu(); selectNode(node.id); }}
            className="w-full text-left px-3 py-1.5 text-xs text-ink hover:bg-line transition-colors"
          >
            Open in Inspector
          </button>
          <button
            disabled={!editable || busy || isRunning || node.type === 'inbox' || node.status === 'queued'}
            onClick={() => { closeContextMenu(); void runNode(node.id); }}
            className="w-full text-left px-3 py-1.5 text-xs text-accent hover:bg-line transition-colors"
          >
            ▶ Run Node
          </button>
          <div className="border-t border-line my-1" />
          <button
            disabled={!editable || busy}
            onClick={() => { closeContextMenu(); setShowSendModal(true); }}
            className="w-full text-left px-3 py-1.5 text-xs text-muted hover:bg-line hover:text-ink transition-colors"
          >
            📤 Send to Team…
          </button>
        </div>
      </>
    )}

    {/* Send to team modal */}
    {showSendModal && (
      <SendToTeamModal
        node={fullNode as WorkerNode}
        onClose={() => setShowSendModal(false)}
      />
    )}
    </>
  );
});
