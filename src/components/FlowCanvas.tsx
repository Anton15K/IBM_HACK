import { useCallback, useEffect, useMemo, type MutableRefObject } from 'react';
import StatusLegend from './StatusLegend';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  ReactFlowProvider,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import { useStore } from '../store';
import { WorkerNodeCard } from './WorkerNodeCard';
import { TeamSpaceNode } from './TeamSpaceNode';
import type { WorkerNode, Team } from '../types';
import { statusColor } from '../utils/colors';

const nodeTypes: NodeTypes = {
  worker: WorkerNodeCard as NodeTypes[string],
  teamSpace: TeamSpaceNode as NodeTypes[string],
};

// Node card dimensions (must match WorkerNodeCard CSS width + estimated max height)
const NODE_W = 210; // must match w-[210px] in WorkerNodeCard
const NODE_H = 160; // approximate max card height including footer
const SPACE_PADDING_X = 60;  // left/right padding inside a space
const SPACE_PADDING_TOP = 56; // header height
const SPACE_PADDING_BOT = 32; // bottom padding

interface Props {
  panToTeamRef: MutableRefObject<((teamId: string) => void) | null>;
}

/**
 * Compute the space height required to contain its nodes comfortably.
 * Nodes are positioned with a fixed header offset already factored in (y + SPACE_PADDING_TOP).
 */
function computeSpaceHeight(teamId: string, nodes: WorkerNode[]): number {
  const teamNodes = nodes.filter((n) => n.teamId === teamId);
  if (teamNodes.length === 0) return SPACE_PADDING_TOP + NODE_H + SPACE_PADDING_BOT;
  const maxBottom = Math.max(...teamNodes.map((n) => n.position.y + NODE_H));
  return SPACE_PADDING_TOP + maxBottom + SPACE_PADDING_BOT;
}

/**
 * Compute the space width required to contain its nodes with padding on both sides.
 * Ensures the rightmost card's right edge + SPACE_PADDING_X fits inside the container.
 */
function computeSpaceWidth(teamId: string, nodes: WorkerNode[]): number {
  const teamNodes = nodes.filter((n) => n.teamId === teamId);
  if (teamNodes.length === 0) return SPACE_PADDING_X * 2 + NODE_W;
  const maxRight = Math.max(...teamNodes.map((n) => n.position.x + NODE_W));
  return SPACE_PADDING_X + maxRight + SPACE_PADDING_X;
}

function buildFlowNodes(teams: Team[], nodes: WorkerNode[]): Node[] {
  const flowNodes: Node[] = [];

  for (const team of teams) {
    if (team.space.w <= 0) continue;
    const h = computeSpaceHeight(team.id, nodes);
    const w = computeSpaceWidth(team.id, nodes);
    flowNodes.push({
      id: `space-${team.id}`,
      type: 'teamSpace',
      position: { x: team.space.x, y: team.space.y },
      // Pass dynamic width + height so the space container always fits its cards
      data: { ...team, space: { ...team.space, w, h } },
      draggable: false,
      selectable: true,
      style: { zIndex: -1 },
    });
  }

  for (const n of nodes) {
    const team = teams.find((t) => t.id === n.teamId);
    const offsetX = (team?.space.x ?? 0) + SPACE_PADDING_X;
    const offsetY = (team?.space.y ?? 0) + SPACE_PADDING_TOP;
    flowNodes.push({
      id: n.id,
      type: 'worker',
      position: {
        x: offsetX + n.position.x,
        y: offsetY + n.position.y,
      },
      data: { ...n },
      draggable: true,
    });
  }

  return flowNodes;
}

function buildFlowEdges(nodes: WorkerNode[]): Edge[] {
  const edges: Edge[] = [];
  for (const node of nodes) {
    for (const inp of node.inputs) {
      if (!inp.enabled) continue;
      const sourceNode = nodes.find((n) => n.id === inp.fromNodeId);
      const isRunning = sourceNode?.status === 'running';
      const baseColor = sourceNode
        ? statusColor(sourceNode.status, sourceNode.priority)
        : '#3A4560';
      edges.push({
        id: `e-${inp.fromNodeId}-${node.id}`,
        source: inp.fromNodeId,
        target: node.id,
        type: 'smoothstep',
        animated: false,
        className: isRunning ? 'running-edge' : undefined,
        style: {
          stroke: baseColor,
          strokeWidth: isRunning ? 2.2 : 2,
          opacity: 0.9,
        },
        markerEnd: {
          type: 'arrowclosed' as const,
          color: baseColor,
          width: 22,
          height: 22,
        },
      });
    }
  }
  return edges;
}

function FlowInner({ panToTeamRef }: Props) {
  const teams = useStore((s) => s.teams);
  const storeNodes = useStore((s) => s.nodes);
  const addStoreEdge = useStore((s) => s.addEdge);
  const updateNode = useStore((s) => s.updateNode);
  const selectNode = useStore((s) => s.selectNode);
  const selectedNodeId = useStore((s) => s.selectedNodeId);

  const initialFlowNodes = useMemo(() => buildFlowNodes(teams, storeNodes), []); // eslint-disable-line react-hooks/exhaustive-deps
  const initialFlowEdges = useMemo(() => buildFlowEdges(storeNodes), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(initialFlowNodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(initialFlowEdges);

  const { fitView } = useReactFlow();

  useEffect(() => {
    setFlowNodes(buildFlowNodes(teams, storeNodes));
    setFlowEdges(buildFlowEdges(storeNodes));
  }, [storeNodes, teams, setFlowNodes, setFlowEdges]);

  useEffect(() => {
    panToTeamRef.current = (teamId: string) => {
      const team = teams.find((t) => t.id === teamId);
      if (!team || team.space.w <= 0) return;
      fitView({
        nodes: [{ id: `space-${teamId}` }],
        duration: 500,
        padding: 0.15,
      });
    };
  }, [teams, fitView, panToTeamRef]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      addStoreEdge(connection.source, connection.target);
      setFlowEdges((eds) => addEdge(connection, eds));
    },
    [addStoreEdge, setFlowEdges]
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      if (node.type !== 'worker') return;
      const storeNode = storeNodes.find((n) => n.id === node.id);
      if (!storeNode) return;
      const team = teams.find((t) => t.id === storeNode.teamId);
      const offsetX = (team?.space.x ?? 0) + SPACE_PADDING_X;
      const offsetY = (team?.space.y ?? 0) + SPACE_PADDING_TOP;
      updateNode(node.id, {
        position: {
          x: node.position.x - offsetX,
          y: node.position.y - offsetY,
        },
      });
    },
    [storeNodes, teams, updateNode]
  );

  const onNodeClick = useCallback(
    (_event: unknown, node: Node) => {
      if (node.type === 'worker') selectNode(node.id);
    },
    [selectNode]
  );

  const onPaneClick = useCallback(() => selectNode(null), [selectNode]);

  const nodesWithSelection = useMemo(
    () => flowNodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })),
    [flowNodes, selectedNodeId]
  );

  return (
    <ReactFlow
      nodes={nodesWithSelection}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      minZoom={0.1}
      maxZoom={2}
      deleteKeyCode={null}
    >
      {/* Dot grid — raised brightness so it's perceptible on dark canvas */}
      <Background
        variant={BackgroundVariant.Dots}
        gap={22}
        size={2}
        color="#2A3550"
      />
      <Controls showInteractive={false} />
      <MiniMap
        nodeColor={(n) => {
          if (n.type === 'teamSpace') return 'rgba(42,51,71,0.5)';
          const storeNode = storeNodes.find((sn) => sn.id === n.id);
          if (!storeNode) return '#4B5563';
          return statusColor(storeNode.status, storeNode.priority);
        }}
        nodeStrokeColor={(n) => {
          if (n.type === 'teamSpace') return '#3A4A62';
          return 'transparent';
        }}
        nodeStrokeWidth={2}
        // pannable + zoomable lets users click to navigate the main viewport
        pannable
        zoomable
        maskColor="rgba(7,10,16,0.72)"
        style={{
          background: '#0a0d14',
          border: '1px solid #2A3347',
          borderRadius: 14,
        }}
      />
    </ReactFlow>
  );
}

export default function FlowCanvas({ panToTeamRef }: Props) {
  return (
    <ReactFlowProvider>
      <div className="w-full h-full relative">
        <FlowInner panToTeamRef={panToTeamRef} />
        <StatusLegend />
      </div>
    </ReactFlowProvider>
  );
}
