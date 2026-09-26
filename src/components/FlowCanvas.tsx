import { useEffect, useMemo, useRef } from 'react';
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
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import { useStore } from '../store';
import { boardNodes, ancestors } from '../client-helpers';
import { WorkerNodeCard } from './WorkerNodeCard';
import { statusColor } from '../utils/colors';
import StatusLegend from './StatusLegend';
function OrganizationCard({ data }: NodeProps) {
  return (
    <div className="bg-card border border-line rounded-[14px] p-5 w-[230px] shadow-panel">
      <Handle type="target" position={Position.Left} />
      <div className="text-accent text-[10px] uppercase tracking-widest mb-2">
        {String(data.kind ?? 'team')}
      </div>
      <div className="text-ink font-semibold">{String(data.name)}</div>
      <p className="text-muted text-[11px] mt-2">
        {data.kind !== 'team'
          ? 'Open departments & teams →'
          : 'Open task board →'}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const types = { worker: WorkerNodeCard, organization: OrganizationCard };
function Canvas() {
  const state = useStore();
  const dragging = useRef(new Set<string>());
  const activeNodes = boardNodes(
    state.nodes,
    state.selectedTeamId,
    state.selectedGraphId,
  );
  const children = state.teams.filter((t) => t.parentId === state.navigationId);
  const board = !!state.selectedTeamId;
  const editable = board && state.canEdit(state.selectedTeamId!);
  const nodes: Node[] = board
    ? activeNodes.map((n) => ({
        id: n.id,
        type: 'worker',
        position: n.position,
        data: { ...n },
        selected: n.id === state.selectedNodeId,
        draggable: !!editable,
      }))
    : children.map((t, i) => ({
        id: t.id,
        type: 'organization',
        position: { x: 80 + (i % 3) * 310, y: 80 + Math.floor(i / 3) * 210 },
        data: { ...t },
        draggable: false,
      }));
  const edges: Edge[] = board
    ? activeNodes.flatMap((n) =>
        n.inputs
          .filter(
            (i) => i.enabled && activeNodes.some((s) => s.id === i.fromNodeId),
          )
          .map((i) => {
            const source = activeNodes.find((s) => s.id === i.fromNodeId)!;
            return {
              id: `${i.fromNodeId}:${n.id}`,
              source: i.fromNodeId,
              target: n.id,
              type: 'smoothstep',
              style: {
                stroke: statusColor(source.status, source.priority),
                strokeWidth: 2,
              },
              label: undefined,
            };
          }),
      )
    : [];
  if (!board) {
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
          edges.push({
            id,
            source,
            target,
            type: 'smoothstep',
            label: 'Handoff',
            style: { stroke: '#5B8CFF' },
          });
        }
      }
  }
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
    editable,
  ]);
  return (
    <>
      <ReactFlow
        nodes={flow}
        edges={edges}
        nodeTypes={types}
        onNodesChange={onNodesChange}
        nodesConnectable={!!editable}
        nodesDraggable={!!editable}
        deleteKeyCode={null}
        onConnect={(c) => {
          if (editable && c.source && c.target)
            state.addEdge(c.source, c.target);
        }}
        onEdgeDoubleClick={(_, edge) => {
          if (editable) state.removeEdge(edge.source, edge.target);
        }}
        onNodeClick={(_, node) =>
          board ? state.selectNode(node.id) : state.navigate(node.id)
        }
        onPaneClick={() => state.selectNode(null)}
        onNodeDragStart={(_, node) => dragging.current.add(node.id)}
        onNodeDragStop={(_, node) => {
          dragging.current.delete(node.id);
          state.updateNode(node.id, { position: node.position });
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
      {!nodes.length && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-muted text-sm">
          {board
            ? 'No tasks in this project. Create a task or apply a template.'
            : 'No departments or teams at this level.'}
        </div>
      )}
      {board && <StatusLegend />}
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
