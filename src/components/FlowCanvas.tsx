import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  getBezierPath,
} from '@xyflow/react';
import { useStore } from '../store';
import { boardNodes, ancestors } from '../client-helpers';
import { teamPositions } from '../canvas-layout';
import { PlacementGesture } from '../canvas-gesture';
import { WorkerNodeCard } from './WorkerNodeCard';
import { statusColor } from '../utils/colors';
import StatusLegend from './StatusLegend';

// ─── Placement mode types ─────────────────────────────────────────────────────
type PlacementMode =
  | { kind: 'team'; name: string }
  | { kind: 'dept'; name: string }
  | { kind: 'worker' }
  | { kind: 'gate' }
  | null;

// ─── OrganizationCard ─────────────────────────────────────────────────────────
function OrganizationCard({ data }: NodeProps) {
  const navigate = useStore((s) => s.navigate);

  const handleNavigate = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(String(data.id));
  };

  return (
    <div className="bg-card border border-line rounded-[14px] p-5 w-[230px] shadow-panel select-none">
      <Handle type="target" position={Position.Left} />
      <div className="text-accent text-[10px] uppercase tracking-widest mb-2">
        {String(data.kind ?? 'team')}
      </div>
      <h2 className="text-ink font-semibold mb-2">{String(data.name)}</h2>
      {Boolean(data.currentTaskLabel) && (
        <p className="text-muted text-[10px] mb-2 truncate">{String(data.currentTaskLabel)}</p>
      )}
      <button
        type="button"
        className="nodrag nopan action-button text-[11px] mt-1 w-full"
        aria-label={`Open ${String(data.name)}`}
        onClick={handleNavigate}
      >
        {data.kind !== 'team' ? 'Open →' : 'Open board →'}
      </button>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

// ─── Edge with enabled/disabled toggle + disconnect ──────────────────────────
interface EdgeEditorProps {
  fromNodeId: string;
  toNodeId: string;
  enabled: boolean;
  editable: boolean;
  onClose: () => void;
  x: number;
  y: number;
}

function EdgeEditor({ fromNodeId, toNodeId, enabled, editable, onClose, x, y }: EdgeEditorProps) {
  const updateNode = useStore((s) => s.updateNode);
  const removeEdge = useStore((s) => s.removeEdge);
  const nodes = useStore((s) => s.nodes);

  const handleToggle = () => {
    if (!editable) return;
    const target = nodes.find((n) => n.id === toNodeId);
    if (!target) return;
    updateNode(toNodeId, {
      inputs: target.inputs.map((inp) =>
        inp.fromNodeId === fromNodeId ? { ...inp, enabled: !inp.enabled } : inp
      ),
    });
    onClose();
  };

  const handleDisconnect = () => {
    if (!editable) return;
    removeEdge(fromNodeId, toNodeId);
    onClose();
  };

  return (
    <div
      className="fixed z-50 bg-panel border border-line rounded-xl shadow-panel p-3 min-w-[160px] text-xs"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-muted text-[10px] uppercase tracking-widest mb-2">Edge</div>
      <label className="flex items-center gap-2 mb-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={enabled}
          onChange={handleToggle}
          disabled={!editable}
          className="accent-accent"
        />
        <span className={enabled ? 'text-ink' : 'text-muted'}>Enabled</span>
      </label>
      <button
        className="small-button w-full text-left text-err border-err/30"
        disabled={!editable}
        onClick={handleDisconnect}
      >
        Disconnect
      </button>
      <button className="small-button w-full text-left mt-1" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

// ─── Custom edge: renders disabled as dashed/muted ───────────────────────────
function CanvasEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const enabled = (data as Record<string, unknown>)?.enabled !== false;
  const stroke = enabled
    ? (selected ? '#5B8CFF' : String((data as Record<string, unknown>)?.color ?? '#5B8CFF'))
    : '#444c5e';
  const strokeDasharray = enabled ? undefined : '6 4';
  const strokeOpacity = enabled ? 1 : 0.5;

  return (
    <g>
      {/* Wider invisible hit zone for easier clicking */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        style={{ cursor: 'pointer' }}
      />
      <path
        d={edgePath}
        fill="none"
        stroke={stroke}
        strokeWidth={selected ? 2.5 : 2}
        strokeDasharray={strokeDasharray}
        strokeOpacity={strokeOpacity}
        style={{ transition: 'stroke 0.2s' }}
      />
    </g>
  );
}

const nodeTypes = { worker: WorkerNodeCard, organization: OrganizationCard };
const edgeTypes = { canvas: CanvasEdge };

// ─── Compact canvas toolbar ───────────────────────────────────────────────────
interface CanvasToolbarProps {
  placement: PlacementMode;
  onStartPlacement: (mode: PlacementMode) => void;
  isAdmin: boolean;
  board: boolean;
  canCreateNode: boolean;
}

function CanvasToolbar({ placement, onStartPlacement, isAdmin, board, canCreateNode }: CanvasToolbarProps) {
  const [nameInput, setNameInput] = useState('');
  const [pendingKind, setPendingKind] = useState<'team' | 'dept' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (pendingKind && inputRef.current) inputRef.current.focus();
  }, [pendingKind]);

  const handleEscape = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setPendingKind(null);
      setNameInput('');
      onStartPlacement(null);
    }
  };

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameInput.trim() || !pendingKind) return;
    onStartPlacement(
      pendingKind === 'team'
        ? { kind: 'team', name: nameInput.trim() }
        : { kind: 'dept', name: nameInput.trim() }
    );
    setPendingKind(null);
    setNameInput('');
  };

  const startKind = (kind: 'team' | 'dept') => {
    if (placement) { onStartPlacement(null); return; }
    setPendingKind(kind);
    setNameInput('');
  };

  const cancelPlacement = () => {
    onStartPlacement(null);
    setPendingKind(null);
    setNameInput('');
  };

  if (board) {
    // Board toolbar: place worker / gate
    return (
      <div
        className="nodrag nopan absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-panel border border-line rounded-xl px-3 py-2 shadow-panel flex-wrap"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className={`small-button ${placement?.kind === 'worker' ? 'action-button' : ''}`}
          disabled={!canCreateNode}
          title="Click canvas to place worker node"
          onClick={() => onStartPlacement(placement?.kind === 'worker' ? null : { kind: 'worker' })}
          aria-pressed={placement?.kind === 'worker'}
        >
          + Worker
        </button>
        <button
          className={`small-button ${placement?.kind === 'gate' ? 'action-button' : ''}`}
          disabled={!canCreateNode}
          title="Click canvas to place gate node"
          onClick={() => onStartPlacement(placement?.kind === 'gate' ? null : { kind: 'gate' })}
          aria-pressed={placement?.kind === 'gate'}
        >
          + Gate
        </button>
        {placement && (
          <>
            <span className="text-muted text-[11px]">
              Click canvas to place · <kbd className="text-[10px]">Esc</kbd> cancels
            </span>
            <button className="small-button text-err border-err/30" onClick={cancelPlacement}>
              Cancel
            </button>
          </>
        )}
      </div>
    );
  }

  // Org toolbar: create team / dept
  if (!isAdmin) return null;

  return (
    <div
      className="nodrag nopan absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-panel border border-line rounded-xl px-3 py-2 shadow-panel flex-wrap"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={handleEscape}
    >
      {!pendingKind && !placement && (
        <>
          <button className="small-button" onClick={() => startKind('dept')}>+ Department</button>
          <button className="small-button" onClick={() => startKind('team')}>+ Team</button>
        </>
      )}
      {pendingKind && !placement && (
        <form className="flex items-center gap-2" onSubmit={handleNameSubmit}>
          <span className="text-muted text-[11px]">
            {pendingKind === 'dept' ? 'Department' : 'Team'} name:
          </span>
          <input
            ref={inputRef}
            className="form-input w-36 py-1"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={pendingKind === 'dept' ? 'e.g. Engineering' : 'e.g. Frontend'}
            required
            aria-label="Name"
          />
          <button className="action-button" type="submit" disabled={!nameInput.trim()}>
            Next: click canvas
          </button>
          <button className="small-button" type="button" onClick={cancelPlacement}>
            Cancel
          </button>
        </form>
      )}
      {placement && (placement.kind === 'team' || placement.kind === 'dept') && (
        <>
          <span className="text-muted text-[11px]">
            Click canvas to place "{(placement as { kind: string; name: string }).name}" · <kbd className="text-[10px]">Esc</kbd> cancels
          </span>
          <button className="small-button text-err border-err/30" onClick={cancelPlacement}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}

// ─── Canvas (inner, has access to ReactFlow hooks) ───────────────────────────
function Canvas() {
  const state = useStore();
  const { screenToFlowPosition } = useReactFlow();
  const dragging = useRef(new Set<string>());
  const placementGesture = useRef(new PlacementGesture());

  const [placement, setPlacement] = useState<PlacementMode>(null);
  const [edgeEditor, setEdgeEditor] = useState<{
    fromNodeId: string;
    toNodeId: string;
    enabled: boolean;
    x: number;
    y: number;
  } | null>(null);

  const activeNodes = boardNodes(
    state.nodes,
    state.selectedTeamId,
    state.selectedGraphId,
  );
  const children = state.teams.filter((t) => t.parentId === state.navigationId);
  const board = !!state.selectedTeamId;
  const editable = board && state.canEdit(state.selectedTeamId!);
  const isAdmin = state.auth?.role === 'admin';
  const canCreateNode =
    editable &&
    !!state.selectedGraphId &&
    !state.busy.includes('createNode');

  // Cancel placement when graph/navigation changes
  useEffect(() => {
    setPlacement(null);
    setEdgeEditor(null);
  }, [state.selectedGraphId, state.navigationId]);

  useEffect(() => {
    placementGesture.current.cancel();
  }, [placement, state.navigationId, state.selectedGraphId]);

  // Escape key cancels placement
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPlacement(null);
        setEdgeEditor(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const positions = teamPositions(children);
  const nodes: Node[] = board
    ? activeNodes.map((n) => ({
        id: n.id,
        type: 'worker',
        position: n.position,
        data: { ...n },
        selected: n.id === state.selectedNodeId,
        draggable: !!editable && !placement,
      }))
    : children.map((t) => ({
        id: t.id,
        type: 'organization',
        position: positions.get(t.id)!,
        data: { ...t },
        draggable: (!!isAdmin || state.canEdit(t.id)) && !placement,
      }));

  const edges: Edge[] = board
    ? activeNodes.flatMap((n) =>
        n.inputs
          .filter((i) => activeNodes.some((s) => s.id === i.fromNodeId))
          .map((i) => {
            const source = activeNodes.find((s) => s.id === i.fromNodeId)!;
            const edgeId = `${i.fromNodeId}:${n.id}`;
            const selected =
              edgeEditor?.fromNodeId === i.fromNodeId &&
              edgeEditor?.toNodeId === n.id;
            return {
              id: edgeId,
              source: i.fromNodeId,
              target: n.id,
              type: 'canvas',
              selected,
              data: {
                enabled: i.enabled,
                color: statusColor(source.status, source.priority),
              },
            };
          })
      )
    : (() => {
        const result: Edge[] = [];
        const atLevel = (teamId: string) =>
          ancestors(state.teams, teamId).find((t) =>
            children.some((c) => c.id === t.id),
          )?.id;
        const seen = new Set<string>();
        for (const n of state.nodes)
          if (n.inboxMeta) {
            const source = atLevel(n.inboxMeta.sourceTeamId);
            const target = atLevel(n.teamId);
            const id = `${source}:${target}`;
            if (source && target && source !== target && !seen.has(id)) {
              seen.add(id);
              result.push({
                id,
                source,
                target,
                type: 'smoothstep',
                label: 'Handoff',
                style: { stroke: '#5B8CFF' },
              });
            }
          }
        return result;
      })();

  const [flow, setFlow, onNodesChange] = useNodesState(nodes);

  useEffect(() => {
    setFlow((current) =>
      nodes.map((n) =>
        dragging.current.has(n.id)
          ? {
              ...n,
              position:
                current.find((c) => c.id === n.id)?.position ?? n.position,
            }
          : n,
      ),
    );
  }, [
    state.nodes,
    state.teams,
    state.selectedNodeId,
    state.selectedGraphId,
    state.navigationId,
    state.auth,
    editable,
    placement,
  ]);

  const handlePaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (!placement) {
        state.selectNode(null);
        setEdgeEditor(null);
        return;
      }
      if (!placementGesture.current.consume(event.clientX, event.clientY)) return;
      const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });

      if (placement.kind === 'worker' || placement.kind === 'gate') {
        // Guard: recheck permissions at click time
        if (!editable || !state.selectedGraphId || state.busy.includes('createNode')) return;
        void state.createNode(placement.kind, flowPos);
        setPlacement(null);
        return;
      }
      // org/dept placement — guard again in handler (not just toolbar)
      if (!isAdmin || state.busy.includes('createTeam')) return;
      const { name, kind: teamKind } = placement as { kind: 'team' | 'dept'; name: string };
      void state.createTeam(
        name,
        teamKind === 'dept' ? 'department' : 'team',
        state.navigationId ?? undefined,
        flowPos,
      );
      setPlacement(null);
    },
    [placement, state, screenToFlowPosition],
  );

  const handleEdgeClick = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.stopPropagation();
      if (!board) return;
      const [fromNodeId, toNodeId] = edge.id.split(':');
      const target = state.nodes.find((n) => n.id === toNodeId);
      const inp = target?.inputs.find((i) => i.fromNodeId === fromNodeId);
      if (!target || !inp) return;
      // Clamp popover within viewport with 8px margin
      const POP_W = 180;
      const POP_H = 130;
      const MARGIN = 8;
      const cx = Math.min(event.clientX, window.innerWidth - POP_W - MARGIN);
      const cy = Math.min(event.clientY, window.innerHeight - POP_H - MARGIN);
      setEdgeEditor({
        fromNodeId,
        toNodeId,
        enabled: inp.enabled,
        x: Math.max(MARGIN, cx),
        y: Math.max(MARGIN, cy),
      });
    },
    [board, state.nodes],
  );

  const cursorStyle = placement ? 'crosshair' : undefined;

  return (
    <>
      <div
        style={{ width: '100%', height: '100%', cursor: cursorStyle }}
        onPointerDownCapture={(e) => {
          if (!placement) return;
          if (e.button !== 0 || !e.isPrimary) { placementGesture.current.cancel(); return; }
          placementGesture.current.start(e.pointerId, e.clientX, e.clientY,
            e.target instanceof Element && e.target.classList.contains('react-flow__pane'));
        }}
        onPointerMoveCapture={(e) => placementGesture.current.move(e.pointerId, e.clientX, e.clientY)}
        onPointerUpCapture={(e) => placementGesture.current.end(e.pointerId, e.clientX, e.clientY,
          e.target instanceof Element && e.target.classList.contains('react-flow__pane'))}
        onPointerCancelCapture={() => placementGesture.current.cancel()}
        onClick={(e) => { if (edgeEditor) { e.stopPropagation(); setEdgeEditor(null); } }}
      >
        <ReactFlow
          nodes={flow}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          nodesConnectable={!!editable && !placement}
          nodesDraggable={!!editable && !placement}
          panOnDrag={!placement}
          deleteKeyCode={null}
          onConnect={(c) => {
            if (editable && !placement && c.source && c.target)
              state.addEdge(c.source, c.target);
          }}
          onEdgeClick={handleEdgeClick}
          onNodeClick={(_, node) => {
            if (placement) return; // don't select during placement
            if (board) state.selectNode(node.id);
            // org card: navigate happens via explicit Open button only
          }}
          onPaneClick={handlePaneClick}
          onNodeDragStart={(_, node) => dragging.current.add(node.id)}
          onNodeDragStop={(_, node) => {
            dragging.current.delete(node.id);
            if (board) {
              state.updateNode(node.id, { position: node.position });
            } else {
              state.updateTeam(node.id, { space: { x: node.position.x, y: node.position.y } });
            }
          }}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.15}
          maxZoom={2}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={2}
            color="#2A3550"
          />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={board ? '#5B8CFF' : '#27344A'}
            maskColor="rgba(7,10,16,.72)"
          />
        </ReactFlow>
      </div>

      {/* Floating canvas toolbar */}
      {(board ? editable : isAdmin) && (
        <CanvasToolbar
          placement={placement}
          onStartPlacement={setPlacement}
          isAdmin={!!isAdmin}
          board={board}
          canCreateNode={canCreateNode}
        />
      )}

      {/* Empty state */}
      {!nodes.length && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-muted text-sm gap-3">
          {board ? (
            <>
              <span>No tasks in this project.</span>
              {editable && (
                <span className="text-accent text-[12px] pointer-events-auto">
                  Use the toolbar above to place a Worker or Gate node.
                </span>
              )}
            </>
          ) : (
            <>
              <span>No departments or teams at this level.</span>
              {isAdmin && (
                <span className="text-accent text-[12px] pointer-events-auto">
                  Use the toolbar above to create a Department or Team.
                </span>
              )}
            </>
          )}
        </div>
      )}

      {board && <StatusLegend />}

      {/* Edge editor popover */}
      {edgeEditor && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setEdgeEditor(null)}
          />
          <EdgeEditor
            fromNodeId={edgeEditor.fromNodeId}
            toNodeId={edgeEditor.toNodeId}
            enabled={edgeEditor.enabled}
            editable={!!editable}
            onClose={() => setEdgeEditor(null)}
            x={edgeEditor.x}
            y={edgeEditor.y}
          />
        </>
      )}
    </>
  );
}

export default function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
