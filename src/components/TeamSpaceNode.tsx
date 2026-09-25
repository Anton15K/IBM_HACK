import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import type { Team } from '../types';

export type TeamSpaceData = Team & Record<string, unknown>;
export type TeamSpaceNodeType = Node<TeamSpaceData, 'teamSpace'>;

const TEAM_ACCENT_COLORS = ['#5B8CFF', '#34D399', '#FBBF24', '#F87171', '#A78BFA', '#60A5FA'];
function teamAccent(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return TEAM_ACCENT_COLORS[Math.abs(hash) % TEAM_ACCENT_COLORS.length];
}

export const TeamSpaceNode = memo(function TeamSpaceNode({ data, selected }: NodeProps<TeamSpaceNodeType>) {
  const team = data;
  const accent = teamAccent(team.id);

  return (
    <div
      className="rounded-[20px] transition-all duration-200 pointer-events-none"
      style={{
        width: team.space.w,
        height: team.space.h,
        // NO background fill — edges live in the SVG pane (below node HTML pane) and would be
        // occluded by any opaque fill here. The space boundary is communicated by the border +
        // inset shadow alone, which is enough visual cue.
        background: 'transparent',
        border: selected
          ? `1.5px solid ${accent}88`
          : '1.5px solid #2A3347',
        // Inset shadow gives a subtle tinted wash inside the space without occluding edges
        boxShadow: selected
          ? `inset 0 0 0 9999px rgba(14,18,28,0.18), 0 0 0 1px ${accent}22, 0 12px 48px rgba(0,0,0,0.55)`
          : 'inset 0 0 0 9999px rgba(14,18,28,0.14), 0 8px 40px rgba(0,0,0,0.45)',
      }}
    >
      {/* Header strip — has its own background so text stays readable */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 rounded-t-[19px] pointer-events-auto"
        style={{
          background: selected
            ? `linear-gradient(90deg, ${accent}18 0%, rgba(14,18,28,0.80) 100%)`
            : 'rgba(14,18,28,0.80)',
          borderBottom: '1px solid rgba(42,51,71,0.7)',
        }}
      >
        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: accent }} />
        <span className="text-[13px] font-semibold" style={{ color: '#E7EBF4' }}>
          {team.name}
        </span>
        {team.currentTaskLabel && (
          <span className="text-[11px] truncate ml-1" style={{ color: '#6B7794' }}>
            — {team.currentTaskLabel}
          </span>
        )}
      </div>
    </div>
  );
});
