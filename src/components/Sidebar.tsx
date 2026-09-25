import { useState } from 'react';
import { useStore } from '../store';
import type { Team, WorkerNode } from '../types';

interface Props {
  onSelectTeam: (teamId: string) => void;
}

function isLeafTeam(team: Team) {
  return team.space.w > 0;
}

const STATUS_COLORS: Record<string, string> = {
  done: '#34D399',
  running: '#60A5FA',
  failed: '#F87171',
  rework: '#FBBF24',
  needs_approval: '#FBBF24',
  ready: '#5B8CFF',
  queued: '#8B94A7',
  draft: '#4B5563',
  blocked: '#5B7A99',
};

function StatusDot({ status, name }: { status: string; name: string }) {
  const [tip, setTip] = useState(false);
  return (
    <span className="relative inline-flex">
      <span
        className="w-2.5 h-2.5 rounded-full inline-block cursor-default"
        style={{ backgroundColor: STATUS_COLORS[status] ?? '#4B5563' }}
        onMouseEnter={() => setTip(true)}
        onMouseLeave={() => setTip(false)}
        title={name}
      />
      {tip && (
        <span
          className="absolute left-4 top-0 z-50 text-[10px] px-1.5 py-0.5 rounded-md whitespace-nowrap pointer-events-none"
          style={{ background: '#1a2030', color: '#E7EBF4', border: '1px solid #242C3D' }}
        >
          {name}
        </span>
      )}
    </span>
  );
}

function MiniGraph({ nodes }: { nodes: WorkerNode[] }) {
  if (nodes.length === 0) {
    return <div className="text-[10px] italic" style={{ color: '#4B5563' }}>No nodes</div>;
  }
  return (
    <div className="flex items-center gap-0.5 flex-wrap">
      {nodes.map((n, i) => (
        <div key={n.id} className="flex items-center">
          <StatusDot status={n.status} name={`${n.name} · ${n.status}`} />
          {i < nodes.length - 1 && (
            <div className="w-3 h-px ml-0.5" style={{ background: '#242C3D' }} />
          )}
        </div>
      ))}
    </div>
  );
}

interface TreeItemProps {
  team: Team;
  allTeams: Team[];
  allNodes: WorkerNode[];
  depth: number;
  onSelectTeam: (id: string) => void;
  selectedTeamId: string | null;
  activeTeamId: string | null; // team that owns the selected node
  selectTeam: (id: string | null) => void;
}

function TreeItem({
  team, allTeams, allNodes, depth,
  onSelectTeam, selectedTeamId, activeTeamId, selectTeam,
}: TreeItemProps) {
  const children = allTeams.filter((t) => t.parentId === team.id);
  const isLeaf = isLeafTeam(team);
  const teamNodes = allNodes.filter((n) => n.teamId === team.id);
  const isClicked = selectedTeamId === team.id;
  const isActive = activeTeamId === team.id; // owns selected node

  const handleClick = () => {
    if (isLeaf) {
      selectTeam(team.id);
      onSelectTeam(team.id);
    }
  };

  return (
    <div>
      <div
        className={`flex flex-col gap-0.5 rounded-lg cursor-pointer transition-all duration-150 mb-0.5 ${
          isLeaf
            ? isActive
              ? 'border'
              : isClicked
              ? 'border'
              : 'border border-transparent hover:bg-card'
            : 'cursor-default border border-transparent'
        }`}
        style={{
          paddingLeft: `${8 + depth * 12}px`,
          paddingRight: 8,
          paddingTop: 6,
          paddingBottom: 6,
          backgroundColor: isActive
            ? 'rgba(91,140,255,0.12)'
            : isClicked
            ? 'rgba(91,140,255,0.07)'
            : undefined,
          borderColor: isActive
            ? 'rgba(91,140,255,0.45)'
            : isClicked
            ? 'rgba(91,140,255,0.25)'
            : 'transparent',
        }}
        onClick={handleClick}
      >
        {isLeaf ? (
          <>
            <div className="flex items-center gap-1.5">
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: isActive ? '#5B8CFF' : '#3A4A60' }}
              />
              <span
                className="text-xs font-medium truncate"
                style={{ color: isActive ? '#E7EBF4' : '#B0BAD0' }}
              >
                {team.name}
              </span>
              {isActive && (
                <span className="ml-auto text-[9px] px-1 py-0.5 rounded" style={{ background: 'rgba(91,140,255,0.25)', color: '#5B8CFF' }}>
                  active
                </span>
              )}
            </div>
            {team.currentTaskLabel && (
              <div className="text-[10px] truncate" style={{ paddingLeft: '14px', color: '#5A6480' }}>
                {team.currentTaskLabel}
              </div>
            )}
            <div style={{ paddingLeft: '14px', marginTop: 3 }}>
              <MiniGraph nodes={teamNodes} />
            </div>
          </>
        ) : (
          <div className="flex items-center gap-1.5">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1 2.5h8M1 5h5.5M1 7.5h7" stroke="#5A6480" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: '#5A6480' }}>
              {team.name}
            </span>
          </div>
        )}
      </div>
      {children.map((child) => (
        <TreeItem
          key={child.id}
          team={child}
          allTeams={allTeams}
          allNodes={allNodes}
          depth={depth + 1}
          onSelectTeam={onSelectTeam}
          selectedTeamId={selectedTeamId}
          activeTeamId={activeTeamId}
          selectTeam={selectTeam}
        />
      ))}
    </div>
  );
}

export default function Sidebar({ onSelectTeam }: Props) {
  const teams = useStore((s) => s.teams);
  const nodes = useStore((s) => s.nodes);
  const selectedTeamId = useStore((s) => s.selectedTeamId);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const selectTeam = useStore((s) => s.selectTeam);

  const roots = teams.filter((t) => t.parentId === null);

  // Determine which team owns the currently selected node
  const activeTeamId = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId)?.teamId ?? null
    : null;

  return (
    <aside className="w-56 bg-panel border-r border-line flex flex-col overflow-hidden shrink-0">
      <div className="px-3 py-2 border-b border-line flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: '#5A6480' }}>
          All Teams
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {roots.map((root) => (
          <TreeItem
            key={root.id}
            team={root}
            allTeams={teams}
            allNodes={nodes}
            depth={0}
            onSelectTeam={onSelectTeam}
            selectedTeamId={selectedTeamId}
            activeTeamId={activeTeamId}
            selectTeam={selectTeam}
          />
        ))}
      </div>
    </aside>
  );
}
