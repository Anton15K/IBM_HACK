import { useStore } from '../store';

export default function SettingsModal() {
  const toggleSettings = useStore((s) => s.toggleSettings);
  const resetToSeed = useStore((s) => s.resetToSeed);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={toggleSettings}
      />
      <div className="relative bg-panel border border-line rounded-[20px] w-96 shadow-panel z-10">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <span className="text-ink font-semibold">Settings</span>
          <button
            onClick={toggleSettings}
            className="text-muted hover:text-ink transition-colors"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* About */}
          <div>
            <div className="text-muted text-[10px] font-semibold uppercase tracking-widest mb-2">About</div>
            <div className="bg-card border border-line rounded-lg p-3 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted">Version</span>
                <span className="text-ink">0.1.0 M1</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">Stack</span>
                <span className="text-ink">React 18 · React Flow · Zustand</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted">LLM executors</span>
                <span className="text-warn">Next milestone</span>
              </div>
            </div>
          </div>

          {/* Data */}
          <div>
            <div className="text-muted text-[10px] font-semibold uppercase tracking-widest mb-2">Data</div>
            <div className="bg-card border border-line rounded-lg p-3 space-y-2">
              <p className="text-muted text-xs">
                Project data is auto-saved to localStorage. Use Export JSON to back up, Import JSON to restore.
              </p>
              <button
                onClick={() => {
                  if (confirm('This will reset all data to the seed project. Continue?')) {
                    resetToSeed();
                    toggleSettings();
                  }
                }}
                className="w-full py-1.5 rounded-lg text-xs font-medium bg-err/20 hover:bg-err/30 text-err transition-colors border border-err/20"
              >
                Reset to Seed Data
              </button>
            </div>
          </div>

          {/* Status colors reference */}
          <div>
            <div className="text-muted text-[10px] font-semibold uppercase tracking-widest mb-2">Status Colors</div>
            <div className="bg-card border border-line rounded-lg p-3 grid grid-cols-2 gap-1.5">
              {[
                ['draft', '#4B5563'],
                ['ready', '#5B8CFF'],
                ['queued', '#8B94A7'],
                ['running', '#60A5FA'],
                ['blocked', '#5B7A99'],
                ['done', '#34D399'],
                ['failed', '#F87171'],
                ['rework', '#FBBF24'],
                ['needs_approval', '#FBBF24'],
              ].map(([label, color]) => (
                <div key={label} className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-muted text-[10px] capitalize">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-line">
          <button
            onClick={toggleSettings}
            className="w-full py-2 rounded-lg text-sm font-medium bg-accent hover:bg-blue-500 text-white transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
