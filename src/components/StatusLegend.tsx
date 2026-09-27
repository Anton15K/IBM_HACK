import { useState } from 'react';

const STATUS_ENTRIES = [
  { status: 'draft',          color: '#4B5563', label: 'Draft',           desc: 'Node not yet configured' },
  { status: 'ready',          color: '#5B8CFF', label: 'Ready',           desc: 'Configured and waiting to run' },
  { status: 'queued',         color: '#8B94A7', label: 'Queued',          desc: 'Waiting for upstream nodes' },
  { status: 'running',        color: '#60A5FA', label: 'Running',         desc: 'Actively executing (pulsing)' },
  { status: 'blocked',        color: '#5B7A99', label: 'Blocked',         desc: 'Cannot proceed, needs action' },
  { status: 'done',           color: '#34D399', label: 'Done',            desc: 'Completed successfully' },
  { status: 'failed',         color: '#F87171', label: 'Failed',          desc: 'Execution failed' },
  { status: 'rework',         color: '#FBBF24', label: 'Rework',          desc: 'Changes requested, needs retry' },
  { status: 'needs_approval', color: '#FBBF24', label: 'Needs Approval',  desc: 'Gate waiting for human review' },
];

const PRIORITY_ENTRIES = [
  { color: '#4B5563', label: 'Low',      desc: 'Non-urgent work' },
  { color: '#8B94A7', label: 'Normal',   desc: 'Standard priority' },
  { color: '#FBBF24', label: 'High',     desc: 'Elevated urgency' },
  { color: '#F87171', label: 'Critical', desc: 'Red left stripe + flag icon' },
];

export default function StatusLegend() {
  const [open, setOpen] = useState(false);

  return (
    /* Placed in a ReactFlow Panel bottom-left with extra margin to clear the
       built-in Controls (Fit View / zoom) which sit at bottom-left by default.
       We use bottom-[10px] left-[10px] and the Controls sit at their default
       position; the legend button is visually right-shifted via the parent
       Panel. To avoid overlap with React Flow's own Controls block we mount
       the button via a wrapper that the caller places in a Panel slot. */
    <div style={{ position: 'relative' }}>
      {open && (
        <div
          className="absolute w-64 rounded-[14px] p-3 shadow-panel"
          style={{
            bottom: 'calc(100% + 8px)',
            left: 0,
            background: '#0e1219',
            border: '1px solid #242C3D',
          }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: '#5A6480' }}>
            Status
          </div>
          <div className="space-y-1 mb-3">
            {STATUS_ENTRIES.map((e) => (
              <div key={e.status} className="flex items-start gap-2">
                <div className="w-2.5 h-2.5 rounded-full mt-0.5 shrink-0" style={{ backgroundColor: e.color }} />
                <div>
                  <span className="text-[11px] font-medium" style={{ color: '#D0D8EC' }}>{e.label}</span>
                  <span className="text-[10px] ml-1.5" style={{ color: '#5A6480' }}>{e.desc}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="text-[10px] font-semibold uppercase tracking-widest mb-2" style={{ color: '#5A6480' }}>
            Priority
          </div>
          <div className="space-y-1">
            {PRIORITY_ENTRIES.map((e) => (
              <div key={e.label} className="flex items-start gap-2">
                <div className="w-2.5 h-2.5 rounded-full mt-0.5 shrink-0" style={{ backgroundColor: e.color }} />
                <div>
                  <span className="text-[11px] font-medium" style={{ color: '#D0D8EC' }}>{e.label}</span>
                  <span className="text-[10px] ml-1.5" style={{ color: '#5A6480' }}>{e.desc}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 pt-2 text-[10px]" style={{ color: '#5A6480', borderTop: '1px solid #1e2a3a' }}>
            Status is always the primary color signal.<br />
            Critical priority adds a red left stripe + flag icon only.
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Status and priority legend"
        aria-expanded={open}
        className="flex items-center justify-center text-[13px] font-bold transition-colors"
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: open ? '#5B8CFF' : '#161B28',
          color: open ? '#fff' : '#8B94A7',
          border: '1px solid #242C3D',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
        }}
      >
        ?
      </button>
    </div>
  );
}
