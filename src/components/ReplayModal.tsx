import { useState, useEffect, useRef } from 'react';
import type { HistoryEntry } from '../types';

interface Props {
  entry: HistoryEntry;
  nodeName: string;
  onClose: () => void;
}

export default function ReplayModal({ entry, nodeName, onClose }: Props) {
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<'running' | 'done'>('running');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let pct = 0;
    intervalRef.current = setInterval(() => {
      pct = Math.min(pct + 4, 100);
      setProgress(pct);
      if (pct >= 100) {
        clearInterval(intervalRef.current!);
        setPhase('done');
      }
    }, 80);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const formattedTs = new Date(entry.ts).toLocaleString();
  const durationSec = (entry.durationMs / 1000).toFixed(1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-panel border border-line rounded-[20px] w-[460px] shadow-panel z-10">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div>
            <div className="text-ink font-semibold text-sm">▶ Replay Run</div>
            <div className="text-muted text-[10px]">{nodeName}</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-ink">×</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Run metadata */}
          <div className="bg-card border border-line rounded-lg p-3 grid grid-cols-2 gap-2 text-xs">
            <div>
              <div className="text-muted text-[10px]">Provider</div>
              <div className="text-ink font-medium capitalize">{entry.provider}</div>
            </div>
            <div>
              <div className="text-muted text-[10px]">Model</div>
              <div className="text-ink font-medium font-mono">{entry.model}</div>
            </div>
            <div>
              <div className="text-muted text-[10px]">Run time</div>
              <div className="text-ink">{formattedTs}</div>
            </div>
            <div>
              <div className="text-muted text-[10px]">Duration</div>
              <div className="text-ink">{durationSec}s</div>
            </div>
            <div>
              <div className="text-muted text-[10px]">Status</div>
              <div
                className="font-medium capitalize"
                style={{ color: entry.status === 'done' ? '#34D399' : '#F87171' }}
              >
                {entry.status}
              </div>
            </div>
          </div>

          {/* Progress animation */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-muted text-[10px]">
                {phase === 'running' ? 'Replaying execution…' : 'Replay complete (read-only)'}
              </span>
              <span className="text-muted text-[10px]">{progress}%</span>
            </div>
            <div className="h-2 bg-line rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-100"
                style={{
                  width: `${progress}%`,
                  backgroundColor: phase === 'done'
                    ? (entry.status === 'done' ? '#34D399' : '#F87171')
                    : '#60A5FA',
                }}
              />
            </div>
          </div>

          {/* Summary (shown once done) */}
          {phase === 'done' && entry.summary && (
            <div
              className="rounded-lg p-3 border"
              style={{
                backgroundColor: entry.status === 'done' ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)',
                borderColor: entry.status === 'done' ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)',
              }}
            >
              <div
                className="text-[10px] font-semibold uppercase tracking-widest mb-1"
                style={{ color: entry.status === 'done' ? '#34D399' : '#F87171' }}
              >
                {entry.status === 'done' ? 'Output Summary' : 'Error'}
              </div>
              <div className="text-ink text-xs leading-relaxed">{entry.summary}</div>
            </div>
          )}

          <div className="text-muted text-[10px] italic text-center">
            Replay is read-only — node state was not changed.
          </div>
        </div>

        <div className="px-5 py-3 border-t border-line">
          <button
            onClick={onClose}
            className="w-full py-1.5 rounded-lg text-xs font-medium bg-card border border-line text-muted hover:text-ink transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
